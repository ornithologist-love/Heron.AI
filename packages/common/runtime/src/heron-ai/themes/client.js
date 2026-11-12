// HERON_AI palettes register through DSH's native theme registry. DSH's Appearance
// row only offers light/dark/system, so a lower-priority entry shadows it with
// the palettes and the host's follow choice; that choice is saved in
// heron-ai-theme-preference, while DSH's own setting keeps light/dark/system.
function installHeronAiThemes(ctx, React) {
  const h = React.createElement
  const boot = window.__HERON_AI_THEMES__
  if (!boot || (!boot.themes.length && !boot.external)) return
  const css = `
    .heron-ai-appearance{display:flex;flex-direction:column;gap:8px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
    .heron-ai-appearance-title{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary)}
    .heron-ai-appearance-row{display:flex;align-items:stretch;gap:8px;flex-wrap:wrap}
    .heron-ai-appearance-cube{box-sizing:border-box;flex:1 1 180px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:20px 32px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-xl);background:transparent;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);cursor:pointer}
    .heron-ai-appearance-cube:hover:not(.heron-ai-selected){background:var(--dsw-alias-interactive-bg-hover)}
    .heron-ai-appearance-cube.heron-ai-selected{background:var(--dsw-alias-bg-module-platform);border-color:var(--dsw-static-neutral-bluish-400)}
  `
  // The boot script already resolved the host's current palette from the URL.
  let choice = { followHost: boot.followHost, theme: boot.theme ?? '' }, hostId = boot.external?.id
  const listeners = new Set()
  ctx.inject(['theme'], scope => {
    const theme = scope.theme
    const target = () => boot.external && choice.followHost && !choice.theme ? hostId : choice.theme || undefined
    let view
    const snapshot = () => view ??= { ...choice, preference: theme.getTheme().preference }
    const publish = () => { view = undefined; for (const listener of listeners) listener() }
    const enforce = () => {
      // An embedded remote page follows the palette its desktop parent lends it.
      if (window.__HERON_AI_EMBEDDED__?.followsHost) return
      const id = target()
      if (id && theme.getTheme().preference !== id) theme.setTheme(id)
    }
    let pending = Promise.resolve()
    const save = next => {
      choice = next
      pending = pending.then(() => ctx.remote.settings.mutate('heron-ai-theme-preference', [
        { op: 'set', path: ['followHost'], value: next.followHost }, { op: 'set', path: ['theme'], value: next.theme },
      ], undefined)).catch(error => console.warn('Unable to persist the HERON_AI theme choice', error))
    }
    function choose(id) {
      if (id === 'host') { save({ followHost: true, theme: '' }); theme.setTheme('system') }
      else if (boot.themes.some(row => row.id === id)) save({ followHost: false, theme: id })
      else { save({ followHost: false, theme: '' }); theme.setTheme(id) }
      enforce()
      publish()
    }
    for (const row of boot.themes)
      scope.effect(() => theme.register({ id: row.id, colorScheme: row.colorScheme, tokens: row.tokens }), 'heron-ai: register ' + row.id)
    // DSH re-adopts its durable light/dark/system after any settings write;
    // only this row selects themes, so a HERON_AI choice is restored afterwards.
    scope.on('theme/change', () => { queueMicrotask(enforce); publish() })
    enforce()
    scope.provide('heronAiThemes', {
      updateExternal(id) {
        if (!boot.external || hostId === id || !boot.themes.some(row => row.id === id)) return
        hostId = id
        enforce()
        publish()
      },
    })
    const cubes = [
      { id: 'light', key: 'appearance.light', Icon: Ui.IconLightOutlineMedium },
      { id: 'dark', key: 'appearance.dark', Icon: Ui.IconDarkOutlineMedium },
      { id: 'system', key: 'appearance.system', Icon: Ui.IconFollowsystemOutlineMedium },
    ]
    function AppearanceRow({ t }) {
      const state = React.useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) }, snapshot)
      const selected = boot.external && state.followHost && !state.theme ? 'host' : state.theme || state.preference
      const builtins = boot.external ? [cubes[2], cubes[0], cubes[1]] : cubes
      const choices = [
        ...builtins.map(cube => ({ id: cube.id, label: t(cube.key), Icon: cube.Icon })),
        ...(boot.external ? [{ id: 'host', label: boot.external.label, Icon: Ui.IconFollowsystemOutlineMedium }] : []),
        ...boot.themes.map(row => ({ id: row.id, label: row.label,
          Icon: row.colorScheme === 'dark' ? Ui.IconDarkOutlineMedium : Ui.IconLightOutlineMedium })),
      ]
      return h('div', { className: 'heron-ai-appearance' },
        h('div', { className: 'heron-ai-appearance-title' }, t('appearance.title')),
        h('div', { className: 'heron-ai-appearance-row' }, choices.map(({ id, label, Icon }) => h('button', {
          key: id, type: 'button', className: 'heron-ai-appearance-cube' + (selected === id ? ' heron-ai-selected' : ''),
          'aria-pressed': selected === id, onClick: () => choose(id),
        }, h(Icon), label))))
    }
    scope.slots.inject('settings.general.item', () => scope.slots.register({
      name: 'settings.general.item', id: 'appearance', order: 10, priority: -1, locale: 'settings.theme',
    }, AppearanceRow))
    scope.effect(() => {
      const tag = document.createElement('style'); tag.dataset.plugin = 'heron-ai-themes'; tag.textContent = css
      document.head.appendChild(tag)
      return () => tag.remove()
    }, 'heron-ai: appearance styles')
  })
}
