// Passive, content-free input observations. The facade drains a bounded buffer.
(() => {
  if (window !== window.top || !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)
    || window.__heronAiWebViewInputDiagnostics) return;

  const events = [];
  const counts = Object.create(null);
  const pending = new WeakMap();
  const sampledAt = Object.create(null);
  let point = null;
  let dropped = 0;
  const tags = new Set('html body div span button input textarea select option a pre code p section main aside nav header footer form label ul ol li table tr td svg path'.split(' '));
  const roles = new Set('button textbox dialog menu menuitem tab tabpanel link listbox option tree treeitem status tooltip combobox'.split(' '));
  const node = value => {
    if (!(value instanceof Element)) return null;
    const tag = value.localName;
    const role = value.getAttribute('role');
    return {
      tag: tags.has(tag) ? tag : 'other', role: roles.has(role) ? role : '-',
      inert: value.closest('[inert]') !== null,
      disabled: value.matches(':disabled, [aria-disabled="true"]'),
      editable: value instanceof HTMLElement && value.isContentEditable,
    };
  };
  const types = ['pointerdown', 'pointerup', 'pointercancel', 'click', 'contextmenu',
    'dragstart', 'dragend', 'drop', 'gotpointercapture', 'lostpointercapture',
    'focusin', 'focusout', 'wheel', 'keydown'];
  const observe = event => {
    const type = event.type;
    counts[type] = Math.min(1000000000, (counts[type] || 0) + 1);
    if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY))
      point = [Math.round(event.clientX), Math.round(event.clientY)];
    const now = performance.now();
    // Wheel/selection activity remains visible without retaining every frame.
    if (['wheel', 'selectionchange'].includes(type) && now - (sampledAt[type] ?? -1000) < 1000) return;
    sampledAt[type] = now;
    const item = {
      type, at: Math.round(now), target: node(event.target),
      x: point?.[0] ?? 0, y: point?.[1] ?? 0,
      button: Number.isInteger(event.button) ? event.button : -1,
      trusted: event.isTrusted, prevented: event.defaultPrevented, bubbled: false,
    };
    if (events.length === 16) { events.shift(); dropped++; }
    events.push(item);
    pending.set(event, item);
    // Observe cancellation after dispatch, without changing event handling.
    setTimeout(() => { item.prevented = event.defaultPrevented; }, 0);
  };
  const bubble = event => {
    const item = pending.get(event);
    if (item) item.bubbled = true;
  };
  for (const type of types) {
    window.addEventListener(type, observe, { capture: true, passive: true });
    window.addEventListener(type, bubble, { passive: true });
  }
  window.addEventListener('focus', observe, { capture: true, passive: true });
  window.addEventListener('blur', observe, { capture: true, passive: true });
  document.addEventListener('visibilitychange', observe, { passive: true });
  document.addEventListener('selectionchange', observe, { passive: true });

  // Immediate external-link evidence also reaches the host's AI diagnostic panel.
  // No URL, link label, query, credentials or page text leaves the page.
  window.addEventListener('click', event => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    let url;
    try { url = new URL(anchor.href, location.href); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin === location.origin) return;
    setTimeout(() => {
      try { window.chrome?.webview?.postMessage({ event: 'heron-ai-external-link-click', scheme: url.protocol.slice(0, -1),
        targetBlank: anchor.target === '_blank', trusted: event.isTrusted, prevented: event.defaultPrevented }); } catch { }
    }, 0);
  }, { capture: true, passive: true });

  Object.defineProperty(window, '__heronAiWebViewInputDiagnostics', { value: () => {
    const selection = window.getSelection();
    const root = document.getElementById('root');
    const hit = point === null ? [] : document.elementsFromPoint(...point).slice(0, 4).map(element => {
      const rect = element.getBoundingClientRect();
      return { ...node(element), pointer: getComputedStyle(element).pointerEvents,
        rect: [rect.x, rect.y, rect.width, rect.height].map(Math.round) };
    });
    const snapshot = {
      version: 1, at: Math.round(performance.now()), focused: document.hasFocus(), hidden: document.hidden,
      selected: selection !== null && !selection.isCollapsed, ranges: selection?.rangeCount ?? 0,
      rootInert: root?.inert === true, bodyInert: document.body?.inert === true,
      inertCount: Math.min(32, document.querySelectorAll('[inert]').length),
      modalCount: Math.min(32, document.querySelectorAll('dialog[open], [aria-modal="true"]').length),
      htmlPointer: getComputedStyle(document.documentElement).pointerEvents,
      bodyPointer: document.body ? getComputedStyle(document.body).pointerEvents : 'unknown',
      active: node(document.activeElement), hit, counts: { ...counts }, events: events.splice(0), dropped,
    };
    dropped = 0;
    return snapshot;
  } });
})();
