window.__ModuleLoader__.load({
  id: '@common/capabilities',
  factory: require => {
    const React = require('react');
    const {ToolbarItem} = require('@common/toolbar');
    function createCapabilityClient(descriptor) {
    const label = descriptor.label;
    const inject = ['slots', 'sessions', 'remote', 'uiWorkspace'];

    function apply(ctx) {
      const sessions = ctx.get('sessions');
      const listeners = new Set();
      const phases = ['off', 'connecting', 'authorizing', 'ready', 'pending', 'error'];
      let sessionId, child = false, state = null, failure = '', writing, running;
      let requestId = 0, controller, timer, disposed = false;
      const snapshot = () => ({sessionId, child, state, failure, writing});
      const notify = () => { for (const listener of listeners) listener(); };
      const clearPoll = () => { clearTimeout(timer); timer = undefined; };
      const cancelRequest = () => {
        ++requestId; controller?.abort(); controller = undefined; clearPoll();
        if (writing !== undefined) state = null;
      };

      function poll() {
        clearPoll();
        if (disposed || !sessionId || child || failure || listeners.size === 0 || writing !== undefined) return;
        if (!['connecting', 'authorizing', 'pending'].includes(state?.phase)) return;
        timer = setTimeout(() => { timer = undefined; void refresh(); }, 1000);
      }

      async function request(method, enabled) {
        if (disposed || !sessionId || child) return;
        cancelRequest();
        const target = sessionId, id = requestId;
        const current = new AbortController();
        controller = current;
        writing = method === 'POST' ? enabled : undefined;
        if (failure && state?.desired !== false) state = null;
        failure = '';
        notify();
        try {
          const headers = {[descriptor.requestHeader]: window[descriptor.requestTokenName]};
          if (method === 'POST') headers['Content-Type'] = 'application/json';
          const response = await fetch(method === 'GET' ? descriptor.endpoint + '?sessionId=' + encodeURIComponent(target) : descriptor.endpoint, {
            method, headers, credentials: 'same-origin', cache: 'no-store', signal: current.signal,
            ...(method === 'POST' ? {body: JSON.stringify({sessionId: target, enabled})} : {})
          });
          const next = await response.json();
          if (!response.ok) throw new Error(next.message || `${label} 请求失败（${response.status}）`);
          if (typeof next.enabled !== 'boolean' || typeof next.desired !== 'boolean' ||
              !phases.includes(next.phase) || typeof next.message !== 'string' || (next.phase === 'ready' && !next.enabled)) {
            throw new Error(`${label} 状态响应无效。`);
          }
          // Selection and request generations both matter when the user switches back quickly.
          if (disposed || target !== sessionId || id !== requestId) return;
          state = next;
        } catch (error) {
          if (disposed || id !== requestId || current.signal.aborted) return;
          if (method === 'POST') state = null;
          failure = error.message || `无法读取 ${label} 状态。`;
        } finally {
          if (!disposed && id === requestId) {
            controller = undefined; writing = undefined;
            notify(); poll();
          }
        }
      }

      function refresh() {
        if (controller || writing !== undefined) return;
        return request('GET');
      }

      function select() {
        const list = sessions.list.getSnapshot();
        const selection = ctx.uiWorkspace.selection.getSnapshot();
        const nextId = selection.sessionId;
        const nextChild = !!selection.subagentAddress;
        if (nextId === sessionId && nextChild === child) return;
        cancelRequest();
        sessionId = nextId; child = nextChild;
        state = null; failure = ''; writing = undefined;
        running = list.byId[sessionId]?.running;
        notify(); void refresh();
      }

      function useCapability() {
        const [value, setValue] = React.useState(snapshot);
        React.useEffect(() => {
          const changed = () => setValue(snapshot());
          listeners.add(changed); changed(); void refresh();
          return () => {
            listeners.delete(changed);
            if (listeners.size === 0) { cancelRequest(); writing = undefined; }
          };
        }, []);
        return value;
      }

      function CapabilityToggle() {
        const value = useCapability(), current = value.state;
        let statusLabel = '读取状态…', hint = `正在读取当前会话的 ${label} 开关。`;
        if (value.child) { statusLabel = '返回主对话设置'; hint = `子会话的 ${label} 开关请回到主对话设置。`; }
        else if (!value.sessionId) { statusLabel = '请选择会话'; hint = `选中主对话后可以开启 ${label}。`; }
        else if (value.failure) { statusLabel = '状态读取失败'; hint = value.failure + ' 点击重新读取状态。'; }
        else if (value.writing !== undefined) { statusLabel = '正在保存开关…'; hint = `正在保存${value.writing ? '开启' : '关闭'}请求，当前${current?.enabled ? '已开启' : '未开启'}。`; }
        else if (current) {
          switch (current.phase) {
            case 'off': statusLabel = '未开启'; hint = `点击开启当前会话的 ${label}。`; break;
            case 'connecting': statusLabel = descriptor.connectingLabel; hint = descriptor.connectingHint; break;
            case 'authorizing': statusLabel = '等待浏览器授权'; hint = `请在浏览器完成 ${label} 授权；点击可取消。`; break;
            case 'ready': statusLabel = descriptor.enabledLabel; hint = descriptor.enabledHint; break;
            case 'pending':
              statusLabel = `下轮${current.desired ? '开启' : '关闭'}（本轮${current.enabled ? '已开启' : '未开启'}）`;
              hint = '当前轮仍使用原开关；修改在下轮生效。点击可更改下轮开关。'; break;
            case 'error': statusLabel = descriptor.errorLabel; hint = descriptor.errorHint; break;
          }
          if (current.message) hint = current.message + ' ' + hint;
        }
        const color = value.failure || current?.phase === 'error' ? '--dsw-alias-state-error-primary' :
          current?.phase === 'ready' ? '--dsw-alias-brand-text' :
          ['connecting', 'authorizing', 'pending'].includes(current?.phase) ? '--dsw-alias-state-warn-primary' : '--dsw-alias-label-secondary';
        const style = {display: 'inline-flex', alignItems: 'center', gap: 5, minHeight: 30, cursor: 'pointer', background: 'transparent', color: `var(${color})`,
          border: 0, borderRadius: 6, padding: '4px 6px', fontSize: 13, whiteSpace: 'nowrap'};
        const normal = !value.failure && value.writing === undefined && !value.child && value.sessionId && ['ready', 'off'].includes(current?.phase);
        const toggle = React.createElement('button', {
          type: 'button', 'aria-pressed': current?.enabled === true,
          'aria-busy': value.writing !== undefined || ['connecting', 'authorizing'].includes(current?.phase),
          disabled: !value.sessionId || value.child || value.writing !== undefined || (!current && !value.failure),
          title: `当前对话 · ${label}\n${statusLabel}\n${hint}`,
          'aria-label': `${label} · ${statusLabel}`,
          onClick: () => {
            if (disposed || child || !sessionId || writing !== undefined) return;
            if (failure) { void refresh(); return; }
            if (state) void request('POST', state.phase === 'error' ? false : !state.desired);
          },
          style
        }, React.createElement('svg', {width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
          strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, style: {flexShrink: 0}},
          React.createElement('path', {d: descriptor.iconPath})),
        React.createElement('span', {'data-common-tool-label': true}, `${label}`),
        current?.phase === 'ready' && normal ? React.createElement('span', {'aria-hidden': true, style: {fontSize: 11}}, '✓') :
          !normal ? React.createElement('span', {'aria-hidden': true, style: {fontSize: 11}}, value.failure || current?.phase === 'error' ? '!' : '…') : null);
        return React.createElement(ToolbarItem, {id: descriptor.id, label, priority: descriptor.priority, order: descriptor.order,
          attention: !!value.failure || ['error', 'authorizing', 'pending'].includes(current?.phase)}, toggle,
          current?.phase === 'error' && !value.failure && !value.child && value.sessionId ? React.createElement('button', {
            type: 'button', 'aria-label': `重试 ${label}`, title: descriptor.retryHint,
            disabled: value.writing !== undefined,
            onClick: () => {
              if (!disposed && sessionId && !child && writing === undefined && !failure && state?.phase === 'error') void request('POST', state.desired);
            },
            style: {...style, color: 'var(--dsw-alias-label-secondary)', padding: '4px 6px'}
          }, '重试') : null);
      }

      ctx.effect(() => {
        const unsubscribe = sessions.list.subscribe(select);
        const unsubscribeSelection = ctx.uiWorkspace.selection.subscribe(select);
        const unsubscribeStatus = ctx.remote.$on('api-session/status', (id, nextRunning) => {
          if (id !== sessionId || child || nextRunning === running) return;
          running = nextRunning; void refresh();
        });
        select();
        return () => {
          disposed = true; cancelRequest(); unsubscribe(); unsubscribeSelection(); unsubscribeStatus(); listeners.clear();
        };
      });
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left', id: descriptor.slotId, order: descriptor.slotOrder, label
      }, CapabilityToggle));
    }

    return {inject, apply};
    }
    // Library-only client module: capability toggles are registered by each capability package.
    return {inject: [], apply() {}, createCapabilityClient};
  }
});
