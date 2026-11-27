window.__ModuleLoader__.load({
  id: '@common/archived-sessions',
  factory: require => {
    const React = require('react')
    const { Button, IconArchiveOutlineRegular, IconSearchOutlineRegular, Input, Modal } =
      require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const namespace = 'archivedSessions'
    const sectionId = 'archived-sessions'
    const inject = ['locale', 'remoteAccess', 'sessions', 'slots', 'workspaces']

    const zh = {
      title: '已归档的会话',
      search: '搜索会话或工作区',
      workspaces: '按工作区筛选',
      allWorkspaces: '所有工作区',
      noWorkspace: '未分组',
      unnamed: '未命名会话',
      loading: '正在加载归档会话…',
      loadFailed: '归档列表加载失败',
      empty: '没有已归档的会话',
      noResults: '没有匹配的归档会话',
      restore: '取消归档',
      restored: '会话已恢复',
      restoreFailed: '取消归档失败',
      remove: '彻底删除',
      removed: '会话已删除',
      removeFailed: '删除失败，请刷新后重试。',
      deleteUnavailable: '暂时无法检查删除权限。',
      confirmTitle: '彻底删除会话？',
      confirmDescription: '「{title}」的聊天记录和归档文件将永久删除，无法恢复。',
      close: '关闭',
      cancel: '取消',
    }
    const en = {
      title: 'Archived sessions',
      search: 'Search sessions or workspaces',
      workspaces: 'Filter by workspace',
      allWorkspaces: 'All workspaces',
      noWorkspace: 'Ungrouped',
      unnamed: 'Untitled session',
      loading: 'Loading archived sessions…',
      loadFailed: 'Could not load archived sessions',
      empty: 'No archived sessions',
      noResults: 'No matching archived sessions',
      restore: 'Unarchive',
      restored: 'Session unarchived',
      restoreFailed: 'Could not unarchive the session',
      remove: 'Delete permanently',
      removed: 'Session deleted',
      removeFailed: 'Could not delete the session. Refresh and try again.',
      deleteUnavailable: 'Could not check deletion permission.',
      confirmTitle: 'Delete this session permanently?',
      confirmDescription: '“{title}” and its archived files will be permanently deleted.',
      close: 'Close',
      cancel: 'Cancel',
    }

    const css = `
      .heron-archived-sessions{display:grid;gap:14px;color:var(--dsw-alias-label-primary)}
      .heron-archived-sessions h2{margin:0;font-size:16px;font-weight:500;line-height:24px}
      .heron-archived-controls{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
      .heron-archived-search{flex:1 1 190px;min-width:0}
      .heron-archived-controls select{box-sizing:border-box;max-width:100%;min-height:36px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-settings-card-fill);color:inherit;font:inherit;font-size:13px}
      .heron-archived-list{list-style:none;margin:0;padding:0;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}
      .heron-archived-row{display:flex;justify-content:space-between;align-items:center;gap:8px 12px;flex-wrap:wrap;padding:10px 12px}
      .heron-archived-row+.heron-archived-row{border-top:.5px solid var(--dsw-alias-settings-card-stroke)}
      .heron-archived-details{flex:1 1 170px;min-width:0;display:grid;gap:3px}
      .heron-archived-details strong{font-size:14px;font-weight:500;overflow-wrap:anywhere}
      .heron-archived-meta{display:flex;align-items:baseline;flex-wrap:wrap;gap:2px 8px}
      .heron-archived-meta,.heron-archived-status{color:var(--dsw-alias-label-secondary);font-size:12px}
      .heron-archived-actions{display:flex;flex-wrap:wrap;gap:6px}
      .heron-archived-error,button.heron-archived-delete{color:var(--dsw-alias-state-error-primary)}
      .heron-archived-status,.heron-archived-error{margin:0;line-height:20px}
    `

    const endpoint = () => new URL('heron-ai-session-archive', document.baseURI)

    async function archiveRequest(options) {
      const response = await fetch(endpoint(), { credentials: 'same-origin', ...options })
      if (!response.ok) throw new Error('Archive request failed')
      return response.json()
    }

    function useSnapshot(source) {
      const subscribe = React.useCallback(listener => source.subscribe(listener), [source])
      const getSnapshot = React.useCallback(() => source.getSnapshot(), [source])
      return React.useSyncExternalStore(subscribe, getSnapshot)
    }

    function ArchiveRow({ item, dateFormat, access, canDelete, busy, restore, confirm, t }) {
      const { session, workspace } = item
      const restoreAccess = React.useMemo(() => access(session.id), [access, session.id])
      const canRestore = useSnapshot(restoreAccess)
      const title = session.title?.trim() || session.displayTitle?.trim() || t('unnamed')
      const updated = session.updatedAt > 0 ? new Date(session.updatedAt) : null
      return h('li', { className: 'heron-archived-row' },
        h('div', { className: 'heron-archived-details' },
          h('strong', null, title),
          h('div', { className: 'heron-archived-meta' },
            h('span', null, workspace?.title ?? t('noWorkspace')),
            updated && h('time', { dateTime: updated.toISOString() }, dateFormat.format(updated)))),
        h('div', { className: 'heron-archived-actions' },
          canRestore && h(Button, { variant: 'outline', size: 'sm', disabled: busy,
            onClick: () => restore(session.id) }, t('restore')),
          canDelete && h(Button, { variant: 'ghost', size: 'sm', className: 'heron-archived-delete', disabled: busy,
            onClick: () => confirm({ id: session.id, title }) }, t('remove'))))
    }

    function apply(ctx) {
      const t = ctx.locale.bind(namespace)
      const access = id => ctx.remoteAccess.source('session', id, 'workspace/unarchiveSession')
      ctx.effect(() => ctx.locale.register(namespace, { zh, en }))
      ctx.effect(() => {
        const element = document.createElement('style')
        element.textContent = css
        document.head.append(element)
        return () => element.remove()
      })

      function ArchivePanel() {
        const workspaces = useSnapshot(ctx.workspaces.list)
        const sessions = useSnapshot(ctx.sessions.list)
        const [query, setQuery] = React.useState('')
        const [workspaceFilter, setWorkspaceFilter] = React.useState('')
        const [permission, setPermission] = React.useState({ canDelete: false, failed: false })
        const [selection, setSelection] = React.useState(null)
        const [busy, setBusy] = React.useState(false)
        const [feedback, setFeedback] = React.useState(null)
        const [deleteError, setDeleteError] = React.useState(false)
        const dateFormat = new Intl.DateTimeFormat(ctx.locale.getSnapshot().active, { dateStyle: 'medium', timeStyle: 'short' })

        React.useEffect(() => {
          const controller = new AbortController()
          archiveRequest({ signal: controller.signal })
            .then(({ canDelete }) => setPermission({ canDelete: canDelete === true, failed: false }))
            .catch(() => {
              if (!controller.signal.aborted) setPermission({ canDelete: false, failed: true })
            })
          return () => controller.abort()
        }, [])

        const archived = React.useMemo(() => {
          const bySession = new Map()
          for (const project of workspaces.items) {
            for (const id of project.sessionIds) bySession.set(id, project)
          }
          return workspaces.archivedSessionIds
            .filter(id => sessions.byId[id])
            .map(id => ({ session: sessions.byId[id], workspace: bySession.get(id) }))
            .sort((a, b) => b.session.updatedAt - a.session.updatedAt)
        }, [workspaces, sessions])
        const groups = new Map(archived.map(item => [item.workspace?.workspaceId ?? 'ungrouped',
          item.workspace?.title ?? t('noWorkspace')]))
        const filter = groups.has(workspaceFilter) ? workspaceFilter : ''
        const term = query.trim().toLowerCase()
        const rows = archived.filter(({ session, workspace }) =>
          (!filter || (workspace?.workspaceId ?? 'ungrouped') === filter)
          && [session.title, session.displayTitle, workspace?.title ?? t('noWorkspace')]
            .some(label => label?.toLowerCase().includes(term)))

        async function restore(id) {
          setBusy(true)
          setFeedback(null)
          try {
            await ctx.workspaces.unarchiveSession(id)
            setFeedback({ text: t('restored'), error: false })
          } catch (error) {
            setFeedback({ text: t('restoreFailed') + ' · ' + error.message, error: true })
          } finally {
            setBusy(false)
          }
        }

        async function remove() {
          setBusy(true)
          setFeedback(null)
          setDeleteError(false)
          try {
            await archiveRequest({
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Heron-Archive-Action': 'delete' },
              body: JSON.stringify({ sessionId: selection.id }),
            })
            setSelection(null)
            setFeedback({ text: t('removed'), error: false })
          } catch {
            setDeleteError(true)
          } finally {
            setBusy(false)
          }
        }

        const close = () => { if (!busy) setSelection(null) }
        const state = workspaces.state === 'error' || sessions.state === 'error' ? 'loadFailed'
          : workspaces.phase !== 'ready' || sessions.phase !== 'ready' ? 'loading'
          : archived.length === 0 ? 'empty' : rows.length === 0 ? 'noResults' : null
        return h('section', { className: 'heron-archived-sessions' },
          h('h2', null, t('title')),
          h('div', { className: 'heron-archived-controls' },
            h(Input, { className: 'heron-archived-search', type: 'search', value: query,
              placeholder: t('search'), 'aria-label': t('search'), icon: h(IconSearchOutlineRegular, { size: 16 }),
              onChange: event => setQuery(event.target.value) }),
            h('select', { value: filter, 'aria-label': t('workspaces'), onChange: event => setWorkspaceFilter(event.target.value) },
              h('option', { value: '' }, t('allWorkspaces')),
              [...groups].map(([id, label]) => h('option', { key: id, value: id }, label)))),
          feedback && h('p', { className: feedback.error ? 'heron-archived-error' : 'heron-archived-status',
            role: feedback.error ? 'alert' : 'status' }, feedback.text),
          permission.failed && h('p', { className: 'heron-archived-error', role: 'alert' }, t('deleteUnavailable')),
          state ? h('p', { className: 'heron-archived-status', role: 'status' }, t(state))
            : h('ul', { className: 'heron-archived-list' }, rows.map(item => h(ArchiveRow, {
              key: item.session.id, item, dateFormat, access, canDelete: permission.canDelete, busy, restore, t,
              confirm: row => { setDeleteError(false); setSelection(row) },
            }))),
          selection && h(Modal, {
            open: true, onClose: close, closeLabel: t('close'), title: t('confirmTitle'),
            description: t('confirmDescription', { title: selection.title }),
            footer: [
              h(Button, { key: 'cancel', variant: 'outline', disabled: busy, onClick: close,
                'data-modal-autofocus': true }, t('cancel')),
              h(Button, { key: 'delete', variant: 'outline', className: 'heron-archived-delete',
                disabled: busy || !workspaces.archivedSessionIds.includes(selection.id), onClick: remove }, t('remove')),
            ],
          }, deleteError && h('p', { className: 'heron-archived-error', role: 'alert' }, t('removeFailed'))))
      }

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: sectionId, order: 17, label: () => t('title'), locale: namespace,
      }, ArchivePanel))
      ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
        name: 'settings.section.icon', id: sectionId,
      }, ({ size }) => h(IconArchiveOutlineRegular, { size })))
    }

    return { inject, apply }
  },
})
