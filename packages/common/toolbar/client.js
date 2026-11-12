window.__ModuleLoader__.load({
  id: '@common/toolbar',
  factory: require => {
    const React = require('react'), {createPortal} = require('react-dom');
    const Context = React.createContext(null);
    const gap = 6, moreWidth = 32;

    function chooseLayout(width, items, wasCompact = true) {
      const active = items.filter(item => item.full > 0 || item.compact > 0);
      const empty = items.filter(item => item.full === 0 && item.compact === 0).map(item => item.id);
      const required = (list, mode, more = false) => list.reduce((sum, item) => sum + item[mode], more ? moreWidth : 0) +
        gap * Math.max(0, list.length + Number(more) - 1);
      // Restore text with some headroom, so subpixel/font changes do not flicker.
      if (width >= 600 && required(active, 'full') + (wasCompact ? 16 : 0) <= width)
        return {compact: false, hidden: [], empty};
      const hidden = [], visible = [...active];
      if (required(visible, 'compact') <= width) return {compact: true, hidden, empty};
      for (const item of [...active].filter(item => !item.mandatory).sort((a, b) => a.priority - b.priority)) {
        hidden.push(item.id); visible.splice(visible.indexOf(item), 1);
        if (required(visible, 'compact', true) <= width) break;
      }
      return {compact: true, hidden, empty};
    }

    function ToolbarItem({id, label, priority = 50, mandatory = false, order = 500, attention = false, flexible = false, children}) {
      const toolbar = React.useContext(Context), host = React.useRef(null);
      const [container] = React.useState(() => {
        const node = document.createElement('div');
        node.style.cssText = 'display:inline-flex;align-items:center;gap:5px;flex:none;min-width:0;max-width:100%';
        return node;
      });
      React.useLayoutEffect(() => {
        if (!toolbar) return;
        return toolbar.register({id, label, priority, mandatory, order, attention, container, host: host.current});
      }, [toolbar?.register, id, label, priority, mandatory, order, attention, container]);
      React.useLayoutEffect(() => {
        container.style.flex = flexible ? '1 1 0' : 'none';
        container.style.width = flexible ? '100%' : '';
      }, [container, flexible]);
      if (!toolbar) return children;
      const hidden = toolbar.layout.hidden.includes(id);
      const empty = toolbar.layout.empty?.includes(id);
      return React.createElement(React.Fragment, null,
        React.createElement('span', {ref: host, 'data-common-item-host': id,
            style: {display: hidden ? 'none' : 'inline-flex', flex: flexible ? '1 1 0' : 'none', minWidth: 0, order,
            ...(empty ? {position: 'absolute', visibility: 'hidden', pointerEvents: 'none'} : {}),
            ...(id === toolbar.trailing ? {marginLeft: 'auto'} : {})}}),
        createPortal(children, container, id));
    }

    function Toolbar({children, style, expanded = false, ...props}) {
      const root = React.useRef(null), tray = React.useRef(null), button = React.useRef(null), menu = React.useRef(null);
      const items = React.useRef(new Map()), menuHosts = React.useRef(new Map()), observer = React.useRef(null);
      const frame = React.useRef(null), measure = React.useRef(() => {}), layoutRef = React.useRef({compact: true, hidden: []});
      const [layout, setLayout] = React.useState(layoutRef.current), [open, setOpen] = React.useState(false);
      const [revision, setRevision] = React.useState(0);
      const sizes = React.useRef(new Map());
      const internalPointer = React.useRef(null);
      const schedule = React.useCallback(() => {
        if (!root.current) return;
        if (frame.current === null) frame.current = requestAnimationFrame(() => {frame.current = null; measure.current();});
      }, []);
      const register = React.useCallback(item => {
        items.current.set(item.id, item); observer.current?.observe(item.container);
        item.host?.appendChild(item.container); setRevision(value => value + 1); schedule();
        return () => {
          observer.current?.unobserve(item.container); items.current.delete(item.id); sizes.current.delete(item.id);
          item.container.remove(); setRevision(value => value + 1); schedule();
        };
      }, [schedule]);
      // A visible activity control (voice input) sits beside Send, so it leads the right-aligned group.
      // The context meter, when shown, leads that group in turn.
      const shown = id => items.current.has(id) && !layout.hidden.includes(id) && !layout.empty?.includes(id);
      const trailing = ['meter', 'activity'].find(shown) ?? 'send';
      // Registration stays stable while the context publishes placement changes.
      const context = React.useMemo(() => ({register, layout, trailing}), [register, layout, trailing]);
      const place = () => {
        for (const item of items.current.values()) {
          const hidden = layoutRef.current.hidden.includes(item.id);
          const destination = hidden && open ? menuHosts.current.get(item.id) : item.host;
          if (destination && item.container.parentNode !== destination) destination.appendChild(item.container);
          item.container.dataset.commonPlacement = hidden && open ? 'overflow' : 'inline';
          const rect = item.container.getBoundingClientRect(); sizes.current.set(item.id, rect.width);
        }
      };
      measure.current = () => {
        if (!root.current || !tray.current) return;
        const entries = [...items.current.values()].sort((a, b) => a.order - b.order);
        const focused = document.activeElement;
        for (const item of entries) {tray.current.appendChild(item.container); item.container.dataset.commonPlacement = 'inline';}
        root.current.dataset.commonToolbarMode = 'full';
        for (const item of entries) item.full = item.container.getBoundingClientRect().width;
        root.current.dataset.commonToolbarMode = 'compact';
        for (const item of entries) item.compact = item.container.getBoundingClientRect().width;
        const padding = getComputedStyle(root.current);
        const width = root.current.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight);
        const next = expanded
          ? {compact: true, hidden: entries.filter(item => !['activity', 'send'].includes(item.id)).map(item => item.id), empty: []}
          : chooseLayout(width, entries, layoutRef.current.compact);
        root.current.dataset.commonMeasuredWidth = String(width);
        layoutRef.current = next;
        root.current.dataset.commonToolbarMode = next.compact ? 'compact' : 'full';
        place();
        setLayout(previous => previous.compact === next.compact && previous.hidden.join('|') === next.hidden.join('|') &&
          previous.empty?.join('|') === next.empty.join('|') ? previous : next);
        if (focused instanceof HTMLElement && entries.some(item => item.container.contains(focused))) {
          const item = entries.find(item => item.container.contains(focused));
          if (next.hidden.includes(item.id) && !open) button.current?.focus(); else focused.focus({preventScroll: true});
        }
      };
      React.useLayoutEffect(() => {place(); schedule();}, [layout, open, revision, expanded]);
      React.useLayoutEffect(() => {
        observer.current = new ResizeObserver(records => {
          if (records.some(record => record.target === root.current ||
            [...items.current.values()].some(item => item.container === record.target &&
              Math.abs((sizes.current.get(item.id) ?? -1) - record.target.getBoundingClientRect().width) > .5))) schedule();
        });
        observer.current.observe(root.current);
        for (const item of items.current.values()) observer.current.observe(item.container);
        document.fonts?.ready.then(schedule);
        return () => {observer.current.disconnect(); cancelAnimationFrame(frame.current); frame.current = null;};
      }, [schedule]);
      React.useLayoutEffect(() => {
        if (!open) return;
        const close = () => {setOpen(false); button.current?.focus();};
        const outside = event => {
          // React preserves ancestry across the original controls' menu portals.
          if (internalPointer.current === event) return;
          if (!menu.current?.contains(event.target) && !button.current?.contains(event.target)) setOpen(false);
        };
        const escape = event => {if (event.key === 'Escape') {event.preventDefault(); close();}};
        menu.current?.querySelector('button:not(:disabled)')?.focus();
        document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
        return () => {document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape);};
      }, [open]);
      const overflow = expanded ? [] : [...items.current.values()].filter(item => layout.hidden.includes(item.id)).sort((a, b) => a.order - b.order);
      const anchor = button.current?.getBoundingClientRect();
      const menuWidth = Math.min(300, window.innerWidth - 16);
      return React.createElement(Context.Provider, {value: context},
        React.createElement('div', {...props, ref: root, 'data-common-toolbar-mode': layout.compact ? 'compact' : 'full',
          onPointerDownCapture: event => {internalPointer.current = event.nativeEvent; props.onPointerDownCapture?.(event);},
          style: {...style, display: 'flex', flexWrap: 'nowrap', alignItems: 'center', gap, minWidth: 0}},
          // Hosts with a brand hero align the native permission/model
          // breakpoints with toolbar mode. Keep that presentation behavior here
          // through the controls slot, without patching the DSH bundle.
          React.createElement('style', null, `
            [data-common-toolbar-mode="compact"] {--dsh-composer-model-text-display:none;--dsh-composer-model-icon-display:block}
            [data-common-toolbar-mode="compact"] [data-common-placement="inline"] [data-common-tool-label] {display:none}
            [data-common-toolbar-mode] [data-common-placement] [data-slot="conversation.input.permission"] button:has(> span:first-child[aria-hidden]) > span:not([aria-hidden]) {display:block}
            [data-common-toolbar-mode="compact"] [data-common-placement="inline"] [data-slot="conversation.input.permission"] button:has(> span:first-child[aria-hidden]) > span:not([aria-hidden]) {display:none}
            [data-common-toolbar-mode] [data-common-placement] [data-slot="conversation.input.model"] button[aria-haspopup="menu"] {max-width:360px}
          `),
          children,
          React.createElement('div', {ref: tray, 'aria-hidden': true,
            style: {position: 'fixed', visibility: 'hidden', pointerEvents: 'none', display: 'flex', width: 'max-content', left: -10000, top: 0}}),
          overflow.length > 0 && React.createElement('button', {ref: button, type: 'button', title: '更多工具',
            'aria-label': overflow.some(item => item.attention) ? '更多工具 · 有状态需关注' : '更多工具',
            'aria-haspopup': 'dialog', 'aria-expanded': open, onClick: () => setOpen(value => !value),
            style: {width: moreWidth, minWidth: moreWidth, maxWidth: moreWidth, boxSizing: 'border-box', height: 30, padding: 0, flex: 'none', order: 700, border: 0, borderRadius: 6,
              background: 'transparent', color: overflow.some(item => item.attention) ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontSize: 20}}, '⋯'),
          open && overflow.length > 0 && React.createElement('div', {ref: menu, role: 'dialog', 'aria-label': '更多工具',
            style: {position: 'fixed', zIndex: 1200, width: menuWidth, boxSizing: 'border-box', padding: 8,
              left: Math.max(8, Math.min(anchor?.left ?? 8, window.innerWidth - menuWidth - 8)),
              top: Math.max(8, (anchor?.top ?? 8) - (overflow.length * 64 + 16) - 8),
              maxHeight: 'calc(100vh - 16px)', overflowY: 'auto', borderRadius: 12,
              background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', boxShadow: '0 8px 28px #0005'}},
            ...overflow.map(item => React.createElement('div', {key: item.id, style: {padding: '4px 8px', minHeight: 64}},
              React.createElement('div', {style: {fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4}}, item.label),
              React.createElement('div', {ref: node => {if (node) menuHosts.current.set(item.id, node); else menuHosts.current.delete(item.id);}}))))));
    }

    function ComposerToolbar({children, ...props}) {
      const [tools, trailing] = children;
      const [add, file, modes, contexts] = tools.props.children;
      const [right, model, meter, ...send] = trailing.props.children;
      const item = (id, label, priority, order, content, mandatory = false) =>
        React.createElement(ToolbarItem, {key: id, id, label, priority, order, mandatory}, content);
      return React.createElement(Toolbar, props,
        item('attachment', '添加附件与指令', 100, 100, add, true), file, contexts,
        item('permission', '工作区权限', 20, 400, modes.props.children[0]),
        item('plan', '计划模式', 30, 450, modes.props.children[1]),
        item('right', '其他工具', 40, 600, right),
        item('model', '模型与思考强度', 90, 800, model),
        item('meter', '上下文状态', 10, 850, meter),
        item('send', '发送与停止', 100, 900, send, true));
    }
    function NativeComposerToolbar(controls) {
      const item = (id, label, priority, order, content, mandatory = false) =>
        React.createElement(ToolbarItem, {key: id, id, label, priority, order, mandatory}, content);
      return React.createElement(Toolbar, {expanded: controls.expanded, style: {width: '100%'}},
        item('attachment', '添加附件与指令', 100, 100, controls.commands, true), controls.fileInput, controls.left,
        item('permission', '工作区权限', 20, 400, controls.permission),
        item('plan', '计划模式', 30, 450, controls.plan),
        item('right', '其他工具', 40, 600, controls.right),
        item('model', '模型与思考强度', 90, 800, controls.model),
        // Context occupancy sits inside the card, just left of voice input / Send.
        item('meter', '上下文用量', 70, 840, controls.meter),
        React.createElement(ToolbarItem, {key: 'activity', id: 'activity', label: '当前任务', priority: 60, order: 850,
          flexible: controls.expanded}, controls.activity),
        item('send', '发送与停止', 100, 900, controls.submit, true));
    }
    const Hidden = () => null;
    function apply(ctx) {
      ctx.slots.inject('conversation.input.controls', () => ctx.slots.register({
        name: 'conversation.input.controls', id: 'common-composer-controls', priority: -100
      }, NativeComposerToolbar));
      // Turn/step and token/cache-hit pills under the card are diagnostics; the
      // context meter moved into the card is the one reading users act on.
      ctx.slots.inject('conversation.composer.dock', function* () {
        yield ctx.slots.register({name: 'conversation.composer.dock', id: 'activity', order: 0, priority: -100}, Hidden);
        yield ctx.slots.register({name: 'conversation.composer.dock', id: 'usage', order: 1, priority: -100}, Hidden);
      });
    }
    return {inject: ['slots'], ToolbarItem, ComposerToolbar, NativeComposerToolbar, chooseLayout, apply};
  }
});
