import {installCapabilityLifecycle} from './controller.mjs';

export function createCapabilityService(ctx, descriptors = []) {
  const entries = new Map(), ownership = new Map(descriptors.map(descriptor => [descriptor.id, descriptor])), listeners = new Set();
  const discoveryListeners = new Set();
  let discovery;
  const notify = change => { for (const listener of listeners) listener(change); };
  const entryFor = id => {
    const entry = entries.get(id);
    if (!entry && !ownership.has(id)) throw new Error(`Unknown capability: ${id}`);
    return entry;
  };
  const stateForScope = (id, scope) => {
    const entry = entryFor(id);
    if (!entry) return {desired: false, enabled: false, phase: 'off', message: ''};
    if (entry.settings) {
      const enabled = entry.settings.get().enabled;
      return {desired: enabled, enabled, phase: enabled ? 'ready' : 'off', message: ''};
    }
    const {controller} = entry;
    if (!scope?.session) return {desired: controller.defaultEnabled, enabled: controller.defaultEnabled, phase: controller.defaultEnabled ? 'ready' : 'off', message: ''};
    const state = controller.states.get(scope.session.header.id);
    if (state) return controller.snapshot(state.sessionId);
    // A durable subagent lineage cannot confer a live optional capability.
    if (scope.session.header.origin === 'subagent') return {desired: false, enabled: false, phase: 'off', message: ''};
    return controller.snapshot(scope.session.header.id);
  };
  const stateForSession = (id, sessionId, header) => {
    const entry = entryFor(id);
    if (!entry) return {desired: false, enabled: false, phase: 'off', message: ''};
    if (entry.settings) return stateForScope(id);
    const {controller} = entry;
    const agent = ctx.agents.get(sessionId);
    if (agent) return stateForScope(id, agent);
    if (header?.origin === 'subagent') return {desired: false, enabled: false, phase: 'off', message: ''};
    const state = controller.snapshot(sessionId);
    return {...state, enabled: state.desired, phase: state.desired ? 'ready' : 'off'};
  };
  const service = {
    registerSettings(id, settings) {
      const descriptor = ownership.get(id);
      if (!descriptor) throw new Error(`Unknown capability: ${id}`);
      let entry = entries.get(id);
      if (entry && entry.settings !== settings) throw new Error(`Capability already registered: ${id}`);
      if (!entry) {
        const changed = () => notify({capabilityId: id});
        entry = {descriptor, settings, owners: 0, unwatch: settings.watch(changed)};
        entries.set(id, entry); changed();
      }
      // Native preset generations may overlap while older conversations live.
      entry.owners++;
      let disposed = false;
      return () => {
        if (disposed) return; disposed = true;
        if (--entry.owners === 0) {entry.unwatch(); entries.delete(id); notify({capabilityId: id});}
      };
    },
    register(descriptor, controller) {
      if (entries.has(descriptor.id)) throw new Error(`Capability already registered: ${descriptor.id}`);
      if (descriptor.schemaVersion !== 1) throw new Error('Unsupported capability descriptor.');
      ownership.set(descriptor.id, descriptor);
      const entry = {descriptor, controller}; entries.set(descriptor.id, entry);
      const original = controller.onChange;
      controller.onChange = state => { original(state); notify({capabilityId: descriptor.id, sessionId: state.sessionId}); };
      notify({capabilityId: descriptor.id});
      let disposed = false;
      return async () => {
        if (disposed) return; disposed = true;
        if (entries.get(descriptor.id) === entry) entries.delete(descriptor.id);
        notify({capabilityId: descriptor.id});
        await controller.close();
      };
    },
    stateForScope, stateForSession,
    skillAllowed(name, options = {}) {
      for (const descriptor of ownership.values())
        if (descriptor.skillIds?.includes(name) && !stateForScope(descriptor.id, options.scope).enabled) return false;
      return true;
    },
    toolAllowed(raw, options = {}) {
      for (const descriptor of ownership.values())
        if (descriptor.toolsets?.some(toolset => raw.startsWith(toolset + '.')) &&
            !stateForScope(descriptor.id, options.scope).enabled) return false;
      return true;
    },
    filterSessionSkills(skills, sessionId, header) {
      return skills.filter(skill => {
        for (const descriptor of ownership.values())
          if (descriptor.skillIds?.includes(skill.name) && !stateForSession(descriptor.id, sessionId, header).enabled) return false;
        return true;
      });
    },
    subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
    // One optional observer of filesystem Skill discovery. Business packages
    // register it; skill providers attach their roots when it appears.
    observeSkillDiscovery(observer) {
      if (discovery) throw new Error('Skill discovery observer already registered.');
      discovery = observer;
      for (const listener of discoveryListeners) listener(observer);
      return () => {
        if (discovery !== observer) return;
        discovery = undefined;
        for (const listener of discoveryListeners) listener(undefined);
      };
    },
    skillDiscovery() {return discovery;},
    onSkillDiscovery(listener) {
      discoveryListeners.add(listener); listener(discovery);
      return () => discoveryListeners.delete(listener);
    }
  };
  const controllers = () => [...entries.values()].flatMap(entry => entry.controller ? [entry.controller] : []);
  installCapabilityLifecycle(ctx, {
    async created(agent) { for (const controller of controllers()) await controller.created(agent); },
    turnStarted(id) { for (const controller of controllers()) controller.turnStarted(id); },
    async beforeAssembly(agent, signal) {
      let changed = false;
      for (const controller of controllers()) changed = await controller.beforeAssembly(agent, signal) || changed;
      return changed;
    },
    idle(agent) { for (const controller of controllers()) controller.idle(agent); },
    async removed(agent) { for (const controller of controllers()) await controller.removed(agent); }
  });
  return service;
}

export function wrapSessionSkillCatalog(catalog, capabilities, query) {
  const original = catalog.list;
  const wrapped = async function(request, signal) {
    const result = await original.call(this, request, signal);
    const observation = await query.observeSession(request.sessionId, {signal, projectionMode: 'none'});
    let skills;
    try { skills = capabilities.filterSessionSkills(result.skills, request.sessionId, observation.header); }
    finally { observation[Symbol.dispose](); }
    return skills.length === result.skills.length ? result : {...result, skills};
  };
  catalog.list = wrapped;
  return () => { if (catalog.list === wrapped) catalog.list = original; };
}
