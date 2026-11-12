window.__ModuleLoader__.load({
  id: '@common/todo-list',
  factory: require => {
    const React = require('react'), h = React.createElement
    const {
      Button, Input, Modal, Tag, IconChecklistOutlineRegular, IconPlusOutlineRegular, IconEditOutlineRegular,
      IconTrashOutlineRegular,
    } = require('@deepseek-ai/dsh-client-ui-primitives')
    // DSH owns controls and typography; only panel layout and tokens live here.
    // Each to-do is one business card: a bordered rounded surface with a header
    // (check, title, icon actions) and its own description below.
    const css = `
      .tdl{height:100%;min-height:0;overflow:auto;color:var(--dsw-alias-label-primary);container-type:inline-size}
      .tdl-body{display:flex;flex-direction:column;gap:12px;padding:16px;min-width:0}
      .tdl-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
      .tdl-heading{margin:0;font-size:16px;line-height:24px;font-weight:600}
      .tdl-count{margin-left:auto;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
      .tdl-compose{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);min-width:0}
      .tdl-compose .tdl-input{width:100%;box-sizing:border-box}
      .tdl-compose-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
      .tdl-hint{margin:0;margin-right:auto;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
      .tdl-field{display:flex;flex-direction:column;gap:4px;min-width:0}
      .tdl-field .tdl-input{width:100%;box-sizing:border-box}
      .tdl-textarea{width:100%;box-sizing:border-box;min-height:60px;max-height:200px;resize:vertical;padding:6px 8px;
        font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);
        border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);outline:none}
      .tdl-textarea:focus{border-color:var(--dsw-alias-state-business-primary)}
      .tdl-textarea::placeholder{color:var(--dsw-alias-label-dimmed)}
      .tdl-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}
      .tdl-card{display:flex;flex-direction:column;gap:6px;padding:12px;border:1px solid var(--dsw-alias-border-l2);
        border-radius:var(--dsw-radius-md);min-width:0;background:var(--dsw-alias-bg-base)}
      .tdl-card[data-done="true"]{background:var(--dsw-alias-bg-l1)}
      .tdl-card-head{display:flex;align-items:flex-start;gap:8px;min-width:0}
      .tdl-check{flex-shrink:0;margin:2px 0 0;width:16px;height:16px;accent-color:var(--dsw-alias-label-primary);cursor:pointer}
      .tdl-title{flex:1;min-width:0;font-size:14px;line-height:20px;font-weight:600;overflow-wrap:anywhere;white-space:pre-wrap}
      .tdl-card[data-done="true"] .tdl-title{color:var(--dsw-alias-label-tertiary);text-decoration:line-through}
      .tdl-actions{display:flex;align-items:center;gap:2px;flex-shrink:0}
      .tdl-desc{margin:0 0 0 24px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);
        white-space:pre-wrap;overflow-wrap:anywhere;max-height:160px;overflow:auto}
      .tdl-desc[data-expanded="true"]{max-height:none}
      .tdl-more{align-self:flex-start;margin:0 0 0 24px;padding:0;border:0;background:none;cursor:pointer;
        font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
      .tdl-more:hover{color:var(--dsw-alias-label-primary)}
      .tdl-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:24px}
      .tdl-empty{padding:24px 0;text-align:center;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
      .tdl-error{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
      .tdl-caption{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
      @container(max-width:360px){.tdl-body{padding:12px;gap:10px}.tdl-card,.tdl-compose{padding:10px}}
    `
    const ROUTE = '/todo-list'
    const MAX_TITLE = 200
    const MAX_DESCRIPTION = 4000
    // The custom header and JSON content type make the POST something a
    // cross-origin form cannot produce; the route also requires an owner peer.
    const headers = { 'x-todo-list': 'mutate', 'content-type': 'application/json' }
    async function call(method, body) {
      const response = await fetch(ROUTE, { method, headers, credentials: 'same-origin',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      let payload
      try { payload = await response.json() } catch { payload = undefined }
      if (!response.ok) throw Error(payload?.error || '待办请求失败（' + response.status + '）。')
      return payload
    }
    const todoIcon = (size = 14) => h(IconChecklistOutlineRegular, { size })
    const iconButton = (props) => h(Button, { size: 'sm', variant: 'toolbar', ...props })
    // Ctrl/Cmd+Enter saves, Escape cancels: both are convenient inside a textarea.
    const keyHandler = (save, cancel) => event => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save() }
      if (event.key === 'Escape' && cancel) { event.preventDefault(); cancel() }
    }

    function TitleField({ value, onChange, disabled, autoFocus, onKeyDown }) {
      return h(Input, { className: 'tdl-input', value, disabled, autoFocus, maxLength: MAX_TITLE,
        placeholder: '标题（必填，一行）', 'aria-label': '待办标题', onChange: event => onChange(event.target.value), onKeyDown })
    }
    function DescriptionField({ value, onChange, disabled, label, onKeyDown, rows }) {
      return h('textarea', { className: 'tdl-textarea', value, disabled, rows: rows || 3, maxLength: MAX_DESCRIPTION,
        placeholder: '描述（可选，可多行）', 'aria-label': label, onChange: event => onChange(event.target.value), onKeyDown })
    }

    function Card({ todo, busy, onDone, onEdit, onDelete }) {
      const [editing, setEditing] = React.useState(false)
      const [title, setTitle] = React.useState(todo.title)
      const [description, setDescription] = React.useState(todo.description)
      const [expanded, setExpanded] = React.useState(false)
      const cancel = () => { setTitle(todo.title); setDescription(todo.description); setEditing(false) }
      const submit = async () => {
        const nextTitle = title.trim()
        if (!nextTitle) return
        if (nextTitle === todo.title && description.trim() === todo.description) { setEditing(false); return }
        if (await onEdit(nextTitle, description)) setEditing(false)
      }
      const long = todo.description.length > 240 || todo.description.split('\n').length > 6
      return h('li', { className: 'tdl-card', 'data-done': String(todo.done) },
        h('div', { className: 'tdl-card-head' },
          h('input', { type: 'checkbox', className: 'tdl-check', checked: todo.done, disabled: busy || editing,
            'aria-label': (todo.done ? '取消完成：' : '标记完成：') + todo.title,
            onChange: event => void onDone(event.target.checked) }),
          editing
            ? h('div', { className: 'tdl-field', style: { flex: 1 } },
              h(TitleField, { value: title, onChange: setTitle, disabled: busy, autoFocus: true,
                onKeyDown: keyHandler(submit, cancel) }))
            : h('span', { className: 'tdl-title', title: todo.title }, todo.title),
          editing
            ? h('div', { className: 'tdl-actions' },
              h(iconButton, { disabled: busy || !title.trim(), 'aria-label': '保存待办', title: '保存（Ctrl+Enter）',
                onClick: () => void submit() }, '保存'),
              h(iconButton, { disabled: busy, 'aria-label': '取消编辑', title: '取消（Esc）',
                onClick: cancel }, '取消'))
            : h('div', { className: 'tdl-actions' },
              h(iconButton, { disabled: busy, icon: h(IconEditOutlineRegular, { size: 14 }),
                'aria-label': '编辑待办：' + todo.title, title: '编辑', onClick: () => setEditing(true) }),
              h(iconButton, { disabled: busy, icon: h(IconTrashOutlineRegular, { size: 14 }),
                'aria-label': '删除待办：' + todo.title, title: '删除', onClick: () => onDelete(todo) }))),
        editing
          ? h('div', { className: 'tdl-field' },
            h(DescriptionField, { value: description, onChange: setDescription, disabled: busy,
              label: '待办描述', onKeyDown: keyHandler(submit, cancel) }))
          : todo.description
            ? h(React.Fragment, {},
              h('p', { className: 'tdl-desc', 'data-expanded': String(expanded) }, todo.description),
              long && h('button', { type: 'button', className: 'tdl-more', 'aria-expanded': expanded,
                onClick: () => setExpanded(value => !value) }, expanded ? '收起' : '展开全文'))
            : null,
        editing ? null : h('div', { className: 'tdl-meta' },
          h(Tag, { tone: todo.done ? 'quiet' : 'neutral' }, todo.done ? '已完成' : '未完成'),
          h('time', { className: 'tdl-caption', dateTime: new Date(todo.updatedAt).toISOString() },
            new Date(todo.updatedAt).toLocaleString('zh-CN', { hour12: false }))))
    }

    function Panel({ visible, sessionId }) {
      const [state, setState] = React.useState({ todos: [], pending: 0, loaded: false, error: '' })
      const [draft, setDraft] = React.useState({ title: '', description: '' })
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState('')
      const [toolsError, setToolsError] = React.useState('')
      const [deleting, setDeleting] = React.useState(null)
      const alive = React.useRef(true)
      React.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
      const adopt = next => { if (alive.current) setState(value => ({ ...value, ...next, loaded: true })) }
      // An open panel opts this chat in for the Agent's to-do tools, exactly like
      // the archive panel. The tools live in this process only; closing the tab
      // or switching chats mounts nothing, so nothing stays on the wrong chat.
      React.useEffect(() => {
        setToolsError('')
        if (!visible || !sessionId) return
        const controller = new AbortController()
        let timer
        const activate = async (first = false) => {
          try {
            const response = await fetch(first ? ROUTE + '/tools'
              : ROUTE + '/tools?sessionId=' + encodeURIComponent(sessionId), {
              method: first ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
              ...(first ? { headers: { ...headers, 'x-todo-list': 'tools' }, body: JSON.stringify({ sessionId }) } : {}),
            })
            const next = await response.json().catch(() => undefined)
            if (controller.signal.aborted) return
            if (!response.ok) throw Error(next?.error || '待办工具启用失败（' + response.status + '）。')
            if (next.phase === 'error') throw Error(next.message || '待办工具启用失败，请重新打开待办面板。')
            if (next.desired && next.phase !== 'ready') timer = setTimeout(() => void activate(), 1000)
          } catch (error) {
            if (!controller.signal.aborted) setToolsError(error.message || '待办工具启用失败，请重新打开待办面板。')
          }
        }
        void activate(true)
        return () => { controller.abort(); clearTimeout(timer) }
      }, [visible, sessionId])
      React.useEffect(() => {
        if (!visible) return
        let live = true
        call('GET').then(next => { if (live) setState(current => ({ ...current, ...next, loaded: true, error: '' })) },
          error => { if (live) setState(current => ({ ...current, loaded: true, error: error.message })) })
        return () => { live = false }
      }, [visible])
      const run = async (operation, message) => {
        setBusy(true)
        setFailure('')
        try { adopt(await operation()); return true } catch (error) { setFailure(message || error.message); return false } finally {
          if (alive.current) setBusy(false)
        }
      }
      const clearDraft = () => setDraft({ title: '', description: '' })
      const add = async () => {
        const title = draft.title.trim()
        if (!title) return
        if (await run(() => call('POST', { action: 'create', title, description: draft.description }))) clearDraft()
      }
      return h('div', { className: 'tdl' },
        deleting && h(Modal, { open: true, title: '删除待办', closeLabel: '取消删除', description: '删除后无法恢复。',
          onClose: () => { if (!busy) setDeleting(null) },
          footer: h(React.Fragment, {},
            h(Button, { variant: 'outline', disabled: busy, onClick: () => setDeleting(null) }, '取消'),
            h(Button, { variant: 'primary', disabled: busy, onClick: () => void run(
              () => call('POST', { action: 'delete', id: deleting.id }).then(next => { setDeleting(null); return next }),
              '删除失败，请稍后重试。') }, busy ? '正在删除…' : '永久删除')) },
        h('p', { className: 'tdl-caption' }, deleting.title)),
        h('div', { className: 'tdl-body' },
          h('div', { className: 'tdl-head' },
            h('h2', { className: 'tdl-heading' }, '待办'),
            h('span', { className: 'tdl-count', role: 'status' },
              state.loaded ? '未完成 ' + state.pending + ' · 已完成 ' + (state.todos.length - state.pending) : '正在读取…')),
          h('div', { className: 'tdl-compose' },
            h(TitleField, { value: draft.title, disabled: busy,
              onChange: value => setDraft(current => ({ ...current, title: value })),
              onKeyDown: event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void add() } } }),
            h(DescriptionField, { value: draft.description, disabled: busy, label: '新待办描述',
              onChange: value => setDraft(current => ({ ...current, description: value })),
              onKeyDown: keyHandler(add) }),
            h('div', { className: 'tdl-compose-actions' },
              h('span', { className: 'tdl-hint' }, 'Ctrl+Enter 保存'),
              h(Button, { size: 'sm', variant: 'outline', disabled: busy || (!draft.title && !draft.description),
                onClick: clearDraft }, '清空'),
              h(Button, { size: 'sm', variant: 'primary', icon: h(IconPlusOutlineRegular, { size: 14 }),
                disabled: busy || !draft.title.trim(), onClick: () => void add() }, '添加'))),
          failure && h('p', { className: 'tdl-error', role: 'alert' }, failure),
          !failure && toolsError && h('p', { className: 'tdl-error', role: 'alert' }, toolsError),
          !failure && state.error && h('p', { className: 'tdl-error', role: 'alert' }, state.error),
          state.loaded && !state.todos.length && !state.error
            ? h('p', { className: 'tdl-empty' }, '暂无待办。')
            : state.todos.length ? h('ul', { className: 'tdl-list', 'aria-label': '待办列表' },
              ...state.todos.map(todo => h(Card, { key: todo.id, todo, busy,
                onDone: done => run(() => call('POST', { action: 'set-done', id: todo.id, done })),
                onEdit: (title, description) => run(() => call('POST',
                  { action: 'update', id: todo.id, title, description })),
                onDelete: next => setDeleting(next) }))) : null,
          h('p', { className: 'tdl-caption' }, '只保存在这台电脑的当前实例中，不随会话同步。')))
    }

    function apply(ctx) {
      ctx.effect(() => ctx.betterSidebar.registerTab({ id: 'todo-list', title: '待办',
        description: '记录并勾选个人的本机待办；面板打开时当前聊天可以用工具读写同一份待办。', icon: todoIcon, single: true, order: 70,
        component: ({ visible, scope }) => h(Panel, { visible, sessionId: scope?.sessionId }) }), 'todo-list: tab')
      ctx.effect(() => { const style = document.createElement('style'); style.textContent = css; document.head.append(style); return () => style.remove() })
    }
    return { inject: ['betterSidebar'], apply }
  },
})
