// Choices persist independently of native chat history, credentials and resources.
export class SessionCapabilityController {
  constructor({settings, findAgent, findParent = () => undefined, openConnection, prompt,
    defaultEnabled = false, synchronize, onChange = () => {},
    errorMessage = '能力切换未完成，请重试。'}) {
    Object.assign(this, {settings, findAgent, findParent, openConnection, prompt,
      defaultEnabled, synchronize, onChange, errorMessage});
    this.states = new Map(); this.disposed = false; this.writes = Promise.resolve();
  }
  state(sessionId) {
    let state = this.states.get(sessionId);
    if (!state) {
      state = {sessionId, desired: this.settings.get().sessions[sessionId] ?? this.defaultEnabled,
        enabled: false, phase: 'off', message: '', connection: null, unmount: null, job: null,
        children: new Set(), revision: 0, interactive: false, synchronized: undefined, preparing: null, removing: null};
      this.states.set(sessionId, state);
    }
    return state;
  }
  snapshot(sessionId) {
    const {desired, enabled, phase, message} = this.state(sessionId);
    return {desired, enabled, phase, message};
  }
  changed(state) { this.onChange(state); }
  get(sessionId) {
    const state = this.state(sessionId);
    if (state.desired && state.phase === 'off' && !this.disposed) this.start(state, false);
    return this.snapshot(sessionId);
  }
  async set(sessionId, enabled) {
    if (this.disposed) throw new Error('DSH is closing.');
    const state = this.state(sessionId);
    const write = this.writes.then(() => {
      const sessions = {...this.settings.get().sessions};
      if (enabled === this.defaultEnabled) delete sessions[sessionId]; else sessions[sessionId] = enabled;
      return this.settings.replace({sessions});
    });
    this.writes = write.catch(() => {});
    await write;
    if (this.disposed) throw new Error('DSH is closing.');
    state.desired = enabled; state.message = ''; state.revision++; state.interactive = enabled;
    // An unmounted activation can be cancelled; the latest request owns retries.
    if (!enabled && !state.enabled) state.abort?.abort();
    const agent = this.findAgent(sessionId);
    if (agent?.status === 'running') state.phase = 'pending';
    else this.start(state, enabled);
    this.changed(state);
    return this.snapshot(sessionId);
  }
  start(state, interactive) {
    if (state.job || this.disposed) return state.job;
    if (state.removing) return state.removing;
    const agent = this.findAgent(state.sessionId);
    if (agent?.status === 'running') { state.phase = 'pending'; return; }
    if (!this.synchronize && state.desired && !state.connection) return this.prepare(state, interactive);
    const run = signal => this.reconcile(state, interactive, signal);
    let task;
    // Claim true idle synchronously; waking input waits behind maintenance.
    try { task = agent ? agent.runMaintenance(run) : run(); }
    catch (error) {
      if (!agent || !error.message.includes('already has active work')) throw error;
      state.phase = 'pending';
      // This is a background retry, never awaited inside the current driver.
      if (!state.idleWait) state.idleWait = agent.whenIdle().then(() => {
        if (!this.disposed && state.phase === 'pending') this.start(state, state.interactive);
      }).finally(() => { state.idleWait = null; });
      return;
    }
    state.job = task.catch(() => {}).finally(() => {
      state.job = null;
      if (!this.disposed && state.phase !== 'error' && (state.desired !== state.enabled ||
          (this.synchronize && state.desired !== state.synchronized))) this.start(state, state.interactive);
    });
    return state.job;
  }
  prepare(state, interactive) {
    if (state.preparing || this.disposed) return state.preparing;
    const revision = state.revision, abort = new AbortController();
    state.abort = abort; state.phase = 'connecting'; this.changed(state);
    // OAuth and remote discovery do not own the Agent's maintenance slot.
    state.preparing = (async () => {
      try {
        const connection = await this.openConnection({signal: abort.signal, interactive, sessionId: state.sessionId,
          onPhase: phase => {if (!this.disposed && !abort.signal.aborted && state.desired) {state.phase = phase; this.changed(state);}}});
        if (this.disposed || abort.signal.aborted || !state.desired) {await connection.close(); return;}
        state.connection = connection; state.phase = 'pending'; this.changed(state);
        this.start(state, interactive);
      } catch {
        if (!this.disposed && !abort.signal.aborted && revision === state.revision && state.desired) {
          state.phase = 'error'; state.message = this.errorMessage; this.changed(state);
        }
      } finally {
        state.preparing = null;
        if (state.abort === abort) state.abort = null;
        if (!this.disposed && revision !== state.revision && state.desired && !state.enabled && state.phase !== 'error')
          this.start(state, state.interactive);
      }
    })();
    return state.preparing;
  }
  async reconcile(state, interactive, maintenanceSignal) {
    if (this.disposed) return;
    const revision = state.revision;
    const abort = new AbortController(); state.abort = abort;
    const cancel = () => abort.abort(maintenanceSignal.reason);
    maintenanceSignal?.addEventListener('abort', cancel, {once: true});
    if (maintenanceSignal?.aborted) cancel();
    try {
      const enabled = state.desired;
      if (this.synchronize) {
        state.phase = 'connecting'; this.changed(state);
        await this.synchronize({sessionId: state.sessionId, enabled, signal: abort.signal});
        state.synchronized = enabled;
      }
      if (state.desired !== enabled || this.disposed) { state.phase = 'off'; return; }
      if (!enabled) { await this.disconnect(state); return; }
      if (state.connection) {
        const agent = this.findAgent(state.sessionId);
        if (agent && !state.unmount) state.unmount = state.connection.mount(agent.ctx, this.prompt);
        state.enabled = true; state.phase = 'ready'; this.changed(state); return;
      }
      state.phase = 'connecting'; this.changed(state);
      const connection = await this.openConnection({signal: abort.signal, interactive, sessionId: state.sessionId,
        onPhase: phase => { if (state.desired && !this.disposed && !abort.signal.aborted) {state.phase = phase; this.changed(state);} }});
      if (!state.desired || this.disposed || abort.signal.aborted) { await connection.close(); state.phase = 'off'; return; }
      state.connection = connection;
      const agent = this.findAgent(state.sessionId);
      if (agent) state.unmount = connection.mount(agent.ctx, this.prompt);
      state.enabled = true; state.phase = 'ready'; state.message = ''; this.changed(state);
    } catch (error) {
      // A superseded cancelled attempt must not poison a newer explicit enable.
      const superseded = abort.signal.aborted && revision !== state.revision;
      state.phase = superseded || this.disposed || (!this.synchronize && !state.desired) ? 'off' : 'error';
      state.message = state.phase === 'error' ? this.errorMessage : '';
      if (state.connection && !state.enabled) { await state.connection.close().catch(() => {}); state.connection = null; }
      this.changed(state);
    } finally {
      maintenanceSignal?.removeEventListener('abort', cancel);
      if (state.abort === abort) state.abort = null;
    }
  }
  async created(agent) {
    const previous = this.states.get(agent.session.header.id);
    if (previous?.removing) {
      if (this.synchronize) await previous.removing;
      else {
        void previous.removing.then(() => {
          if (!this.disposed && this.findAgent(previous.sessionId) === agent) return this.created(agent);
        }).catch(() => {});
        return;
      }
    }
    const parent = this.findParent(agent);
    if (parent) {
      this.borrow(agent, parent); return;
    }
    if (agent.session.header.origin === 'subagent') return;
    const state = this.state(agent.session.header.id);
    if (!this.synchronize && state.desired && !state.connection) {this.start(state, false); return;}
    if (state.job) await state.job;
    // Restored defaults and persisted false both synchronize native admission.
    if (state.desired || this.synchronize) await this.reconcile(state, false);
  }
  borrow(agent, parent) {
    const parentState = this.states.get(parent.session.header.id);
    if (!parentState?.enabled || !parentState.connection) return false;
    const owner = parentState.owner ?? parentState;
    const state = this.state(agent.session.header.id);
    Object.assign(state, {owner, connection: owner.connection, unmount: owner.connection.mount(agent.ctx, this.prompt),
      desired: true, enabled: true, phase: 'ready'});
    owner.children.add(state); this.changed(state); return true;
  }
  turnStarted(sessionId) { this.state(sessionId).firstAssembly = true; }
  async beforeAssembly(agent, signal) {
    const state = this.state(agent.session.header.id);
    if (!state.firstAssembly) return false;
    state.firstAssembly = false;
    if (state.removing) return false;
    const parent = this.findParent(agent);
    if (parent && !state.connection && this.borrow(agent, parent)) return true;
    if (state.phase !== 'pending') return false;
    if (!this.synchronize && state.desired && !state.connection) {this.prepare(state, state.interactive); return false;}
    if (state.job) await state.job;
    if (signal?.aborted) return false;
    await this.reconcile(state, state.interactive, signal);
    return true;
  }
  idle(agent) {
    const state = this.states.get(agent.session.header.id);
    if (state?.phase === 'pending') this.start(state, state.interactive);
  }
  async disconnect(state) {
    state.unmount?.(); state.unmount = null; state.enabled = false;
    state.phase = 'off'; state.message = '';
    const connection = state.connection; state.connection = null;
    if (state.owner) { state.owner.children.delete(state); this.changed(state); return; }
    for (const child of state.children) {
      child.unmount?.(); child.unmount = null;
      child.connection = null; child.enabled = false; child.desired = false; child.phase = 'off';
      this.changed(child);
    }
    state.children.clear(); this.changed(state);
    if (connection) await connection.close();
  }
  async removed(agent) {
    const state = this.states.get(agent.session.header.id);
    if (!state) return;
    const removal = (async () => {
      state.abort?.abort(); if (state.preparing) await state.preparing; if (state.job) await state.job;
      await this.disconnect(state); state.phase = 'off';
      if (this.synchronize && !state.owner) {
        await this.synchronize({sessionId: state.sessionId, enabled: false}); state.synchronized = false;
      }
      if (state.owner) this.states.delete(state.sessionId);
    })();
    state.removing = removal;
    try {await removal;} finally {if (state.removing === removal) state.removing = null;}
  }
  async close() {
    this.disposed = true;
    for (const state of this.states.values()) state.abort?.abort();
    await Promise.all([...this.states.values()].map(async state => {
      if (state.removing) await state.removing;
      if (state.preparing) await state.preparing;
      if (state.job) await state.job;
      await this.disconnect(state); state.phase = 'off';
      if (this.synchronize && !state.owner) {
        await this.synchronize({sessionId: state.sessionId, enabled: false}); state.synchronized = false;
      }
    }));
    await this.writes;
  }
}

export function installCapabilityLifecycle(ctx, controller) {
  ctx.on('agent/created', async ({agent}) => { await controller.created(agent); });
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') controller.turnStarted(session.header.id);
  });
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    if (context.agent && await controller.beforeAssembly(context.agent, context.signal))
      return context.agent.ctx.systemPrompt.assemble(context);
    return next();
  });
  ctx.on('agent/status', ({agent, status}) => { if (status === 'idle') controller.idle(agent); });
  ctx.on('agent/disposed', ({agent}) => { void controller.removed(agent).catch(() => {}); });
}

export {installCapabilityEndpoint} from './http.mjs';
