function installWorkspaceProjects(ctx, React) {
  const h = React.createElement
    async function api(path, body) {
      const response = await fetch(new URL(path.replace(/^\/+/, ''), document.baseURI), { credentials: 'same-origin', ...(body ? {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      } : {}) })
      const text = await response.text()
      let value
      try { value = text ? JSON.parse(text) : {} }
      catch { throw new Error('工作区服务暂时不可用，请刷新页面后重试') }
      if (!response.ok) throw new Error(value.error ?? 'Workspace request failed')
      return value
    }
  let state = { items: [], error: '' }, editor = null, loading, disposed = false, hostPresentation
  const navigation = window.__HERON_AI_DSH_NAVIGATION__ ?? {}
  let localMachineExpanded = navigation.localMachineExpanded !== false
  let expandedMachines = navigation.expandedMachines ?? {}, savingExpansion = Promise.resolve()
  const setMachineExpanded = (hostId, expanded) => {
    savingExpansion = savingExpansion.then(async () => {
      await ctx.remote.settings.mutate('heron-ai-navigation', [{ op: 'set',
        path: hostId === undefined ? ['localMachineExpanded'] : ['expandedMachines', hostId], value: expanded }], undefined)
      if (hostId === undefined) localMachineExpanded = expanded
      else expandedMachines = { ...expandedMachines, [hostId]: expanded }
      publish(state)
    }).catch(error => publish({ ...state, error: `折叠状态保存失败：${error.message}` }))
  }
  const sessionSections = new Set()
  const listeners = new Set()
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  const snapshot = () => state
  const editorSnapshot = () => editor
  const notify = () => { for (const listener of listeners) listener() }
  const closeEditor = () => { editor = null; notify() }
  async function openEditor(workspaceId) {
    try {
      const value = await api('/heron-ai-workspaces')
      if (disposed) return
      const row = value.items.find(item => item.workspaceId === workspaceId)
      if (!row) throw Error('项目不存在，请刷新后重试')
      editor = row
      publish({ items: value.items, error: (value.errors ?? []).join('；') })
    } catch (error) { publish({ ...state, error: error.message }) }
  }
  // presetIcon is one icon for every preset, or a function choosing per preset row (undefined: default icon).
  const presetIcon = row => typeof hostPresentation?.presetIcon === 'function' ? hostPresentation.presetIcon(row) : hostPresentation?.presetIcon
  const displaySnapshot = value => {
    const classified = [...sessionSections].map(source => source.getSnapshot().classifiedSessionIds).filter(Array.isArray)
    return ({ ungrouped: hostPresentation?.ungrouped ?? 'group', newSession: hostPresentation?.newSession ?? 'inherit', editWorkspace: openEditor,
    machineExpansion: { local: localMachineExpanded, hosts: expandedMachines, setExpanded: setMachineExpanded },
    excludedSessionIds: [...new Set([...sessionSections].flatMap(source => source.getSnapshot().excludedSessionIds))],
    ...(classified.length ? { classifiedSessionIds: classified.reduce((left, right) => left.filter(id => right.includes(id))) } : {}),
    items: value.items.map(row => {
      const icon = row.sourceId ? presetIcon(row) : undefined
      return { workspaceId: row.workspaceId, pinned: Boolean(row.sourceId),
        ...(icon ? { icon: { ...icon,
          title: [row.sourceId, ...row.roots.map(root => `${root.label}: ${root.path}`)].join('\n'),
          ariaLabel: `${icon.alt} 工作区，关联目录：` + row.roots.map(root => root.label).join('、') } } : {}) }
    }) })
  }
  let presentation = displaySnapshot(state)
  const publish = value => { if (!disposed) { state = value; presentation = displaySnapshot(value); notify() } }
  ctx.provide('projectWorkspaces', {
    registerSessionSection(source) {
      sessionSections.add(source)
      const unsubscribe = source.subscribe(() => publish(state))
      publish(state)
      return () => { unsubscribe(); sessionSections.delete(source); publish(state) }
    },
    registerHostPresentation(value) {
      if (hostPresentation) throw Error('Workspace host presentation already registered')
      hostPresentation = value; publish(state)
      return () => { if (hostPresentation === value) { hostPresentation = undefined; publish(state) } }
    },
  })
  ctx.inject(['workspacePresentation'], scope => {
    scope.effect(() => scope.workspacePresentation.register({ subscribe, getSnapshot: () => presentation }))
  })
  const refresh = () => loading ??= api('/heron-ai-workspaces')
    .then(value => publish({ items: value.items, error: (value.errors ?? []).join('；') }))
    .catch(error => publish({ ...state, error: error.message }))
    .finally(() => { loading = null })
      function Icon({ kind, ...props }) {
        const paths = kind === 'close' ? ['m6 6 12 12', 'M18 6 6 18']
          : kind === 'add' ? ['M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v4', 'M3 7h13', 'M3 7v12a2 2 0 0 0 2 2h7', 'M18 15v8', 'M14 19h8']
          : ['M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z', 'M3 9h18']
        return h('svg', { viewBox: '0 0 24 24', width: 22, height: 22, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
          strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, ...props }, paths.map((d, index) => h('path', { d, key: index })))
      }
      const pathKey = value => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      const folderName = value => value.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? value
      function ProjectEditor({ project }) {
        const dialog = React.useRef(null)
        const nameInput = React.useRef(null)
        const [title, setTitle] = React.useState(project.title)
        const [roots, setRoots] = React.useState(() => project.roots.map(root => root.path))
        const [primary, setPrimary] = React.useState(project.primaryPath ?? project.roots[0]?.path)
        const [error, setError] = React.useState('')
        const [saving, setSaving] = React.useState(false)
        const [picking, setPicking] = React.useState(false)
        const busy = saving || picking
        React.useEffect(() => {
          dialog.current.showModal()
          nameInput.current.focus()
          return () => dialog.current?.close()
        }, [])
        const addFolder = async () => {
          setPicking(true); setError('')
          try {
            const picked = await (window.__DSH_DIRECTORY_PICKER__?.pick ? window.__DSH_DIRECTORY_PICKER__.pick() : ctx.uiWorkspace.pickDirectory())
            if (picked && !roots.some(root => pathKey(root) === pathKey(picked))) {
              if (roots.length >= 32) throw Error('源文件夹最多 32 个')
              setRoots(previous => [...previous, picked])
            }
          } catch (failure) { setError(failure.message) }
          finally { setPicking(false) }
        }
        const removeFolder = root => {
          const next = roots.filter(value => value !== root)
          setRoots(next)
          if (root === primary) setPrimary(next[0])
        }
        const save = async action => {
          setSaving(true); setError('')
          try {
            const value = await api('/heron-ai-workspaces', { workspaceId: project.workspaceId, title, roots, primaryPath: primary, action })
            publish({ items: value.items, error: '' })
            closeEditor()
          } catch (failure) { setError(failure.message) }
          finally { setSaving(false) }
        }
        return h('dialog', { ref: dialog, className: 'heron-ai-project-editor', 'aria-labelledby': 'heron-ai-project-editor-title',
          onCancel: event => { event.preventDefault(); if (!busy) closeEditor() } },
          h('form', { onSubmit: event => { event.preventDefault(); if (!busy) void save('save') } },
            h('header', null, h('h2', { id: 'heron-ai-project-editor-title' }, '编辑项目'),
              h('button', { type: 'button', className: 'heron-ai-project-close', 'aria-label': '关闭', disabled: busy, onClick: closeEditor }, h(Icon, { kind: 'close' }))),
            h('label', { className: 'heron-ai-project-name' }, h('span', { className: 'heron-ai-project-name-icon' }, h(Icon, { kind: 'folder' })),
              h('input', { ref: nameInput, value: title, maxLength: 160, disabled: busy, 'aria-label': '项目名称', onChange: event => setTitle(event.target.value), autoComplete: 'off' })),
            h('h3', null, '源文件夹'),
            h('div', { className: 'heron-ai-project-folders' },
              roots.map(root => h('div', { className: 'heron-ai-project-folder', key: root, title: root },
                h(Icon, { kind: 'folder' }), h('span', { className: 'heron-ai-project-folder-name' }, folderName(root)),
                h('button', { type: 'button', className: 'heron-ai-project-primary' + (root === primary ? ' is-primary' : ''), disabled: busy,
                  'aria-label': root === primary ? `${folderName(root)}，主要文件夹` : `将 ${folderName(root)} 设为主要文件夹`,
                  onClick: () => setPrimary(root) }, root === primary ? '主要' : '设为主要'),
                h('button', { type: 'button', className: 'heron-ai-project-remove-folder', disabled: busy || roots.length === 1,
                  'aria-label': `移除 ${folderName(root)}`, onClick: () => removeFolder(root) }, h(Icon, { kind: 'close' })))),
              h('button', { type: 'button', className: 'heron-ai-project-add', disabled: busy, onClick: addFolder }, h(Icon, { kind: 'add' }), picking ? '正在选择…' : '添加文件夹')),
            error ? h('p', { className: 'heron-ai-project-error', role: 'alert' }, error) : null,
            h('footer', null,
              h('button', { type: 'button', className: 'heron-ai-project-remove', disabled: busy, onClick: () => save('remove') }, '移除本地项目'),
              h('span', { className: 'heron-ai-project-footer-spacer' }),
              h('button', { type: 'button', className: 'heron-ai-project-cancel', disabled: busy, onClick: closeEditor }, '取消'),
              h('button', { type: 'submit', className: 'heron-ai-project-save', disabled: busy || !title.trim() || !roots.length }, saving ? '保存中…' : '保存'))))
      }
      function ProjectEditorOverlay() {
        const project = React.useSyncExternalStore(subscribe, editorSnapshot)
        return project ? h(ProjectEditor, { key: project.workspaceId, project }) : null
      }
  function WorkspaceStatus() {
    const current = React.useSyncExternalStore(subscribe, snapshot)
    return current.error ? h('button', { type: 'button', className: 'heron-ai-workspace-sync-error', title: current.error,
      onClick: () => { void refresh() } }, '工作区同步失败 · 重试') : null
  }
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'heron-ai-project-editor' }, ProjectEditorOverlay))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'heron-ai-workspace-status' }, WorkspaceStatus))
  ctx.effect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, 30000)
    const onFocus = () => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', onFocus)
    const tag = document.createElement('style')
        tag.textContent = `
.heron-ai-workspace-sync-error{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:8px;cursor:pointer}
.heron-ai-project-editor{box-sizing:border-box;width:min(572px,calc(100vw - 48px));max-height:calc(100vh - 64px);overflow:auto;margin:auto;border:1px solid var(--dsw-alias-border-l4);border-radius:22px;padding:22px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;box-shadow:0 20px 70px #0003}
.heron-ai-project-editor::backdrop{background:#0007}
.heron-ai-project-editor *{box-sizing:border-box}
.heron-ai-project-editor button,.heron-ai-project-editor input{font:inherit;color:inherit}
.heron-ai-project-editor button{cursor:pointer;border:0;background:none}
.heron-ai-project-editor button:disabled{cursor:default;opacity:.4}
.heron-ai-project-editor header{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}
.heron-ai-project-editor h2{margin:0;font-size:24px;font-weight:650;line-height:1.3}
.heron-ai-project-close{display:flex;padding:4px;color:var(--dsw-alias-label-secondary)!important;border-radius:6px}
.heron-ai-project-close:hover{background:var(--dsw-alias-bg-layer-3)}
.heron-ai-project-name{display:flex;align-items:center;height:44px;border:1px solid var(--dsw-alias-border-l4);border-radius:14px;overflow:hidden;transition:border-color .15s}
.heron-ai-project-name:focus-within{border-color:var(--dsw-alias-label-secondary)}
.heron-ai-project-name-icon{display:flex;align-items:center;justify-content:center;align-self:stretch;width:44px;flex-shrink:0;border-right:1px solid var(--dsw-alias-border-l4)}
.heron-ai-project-name input{width:100%;height:100%;padding:0 10px;min-width:0;border:0;outline:0;background:none;font-size:17px}
.heron-ai-project-editor h3{font-size:17px;font-weight:600;margin:16px 0 8px}
.heron-ai-project-folders{border:1px solid var(--dsw-alias-border-l4);border-radius:12px;overflow:hidden}
.heron-ai-project-folder{display:flex;align-items:center;gap:10px;min-height:53px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l4)}
.heron-ai-project-folder>svg{flex-shrink:0;color:var(--dsw-alias-label-secondary)}
.heron-ai-project-folder-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:17px}
.heron-ai-project-primary{opacity:0;border:1px solid var(--dsw-alias-border-l4)!important;border-radius:13px;padding:3px 10px;white-space:nowrap;color:var(--dsw-alias-label-secondary)!important;font-size:15px!important}
.heron-ai-project-primary.is-primary,.heron-ai-project-folder:hover .heron-ai-project-primary,.heron-ai-project-folder:focus-within .heron-ai-project-primary{opacity:1}
.heron-ai-project-remove-folder{display:flex;align-items:center;justify-content:center;padding:3px;color:var(--dsw-alias-label-secondary)!important}
.heron-ai-project-remove-folder svg{width:16px;height:16px}
.heron-ai-project-add{display:flex;gap:10px;align-items:center;width:100%;padding:15px 14px;text-align:left;font-size:17px!important}
.heron-ai-project-add:hover{background:var(--dsw-alias-bg-layer-3)}
.heron-ai-project-add svg{color:var(--dsw-alias-label-secondary)}
.heron-ai-project-editor footer{display:flex;align-items:center;gap:12px;margin-top:22px}
.heron-ai-project-editor footer button{border-radius:12px;padding:6px 16px;font-size:17px;line-height:1.4}
.heron-ai-project-remove{color:#fa6c64!important;background:color-mix(in srgb,#fa6c64 10%,transparent)!important}
.heron-ai-project-footer-spacer{flex:1}
.heron-ai-project-cancel{color:var(--dsw-alias-label-secondary)!important;padding-inline:10px!important}
.heron-ai-project-save{background:var(--dsw-alias-label-primary)!important;color:var(--dsw-alias-bg-base)!important;min-width:72px}
.heron-ai-project-error{font-size:13px;color:#fa6c64;margin:12px 0 0;overflow-wrap:anywhere}
@media(max-width:520px){.heron-ai-project-editor{padding:18px}.heron-ai-project-editor footer{gap:8px}.heron-ai-project-editor footer button{padding:6px 10px;font-size:14px}.heron-ai-project-primary{font-size:13px!important;padding:3px 7px}}
`
    document.head.appendChild(tag)
    return () => { disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', onFocus); tag.remove() }
  })
}
