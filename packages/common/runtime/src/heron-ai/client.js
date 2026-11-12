window.__ModuleLoader__.load({
  id: '@heron-ai/dsh-heron-ai',
  factory: require => {
    const React = require('react')
    const Ui = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const phoneMedia = matchMedia('(max-width: 767px)')
    const subscribePhone = notify => { phoneMedia.addEventListener('change', notify); return () => phoneMedia.removeEventListener('change', notify) }
    const usePhone = () => React.useSyncExternalStore(subscribePhone, () => phoneMedia.matches)
    /* HERON_AI_WORKSPACES */
    /* HERON_AI_THEMES */
    const templatesPlugin = (() => {
  const React = require('react'), h = React.createElement
  const inject = ['slots', 'sessions', 'workspaces', 'remote', 'remote.session', 'heronAiWidgets']
  function apply(ctx) {
    const api = ctx.heronAiWidgets.api, Widget = ctx.heronAiWidgets.Widget
    const state = new Map(), listeners = new Set(), pending = new Map()
    let loading
    const publish = (id, value) => { state.set(id, value); for (const listener of listeners) listener(id, value); document.dispatchEvent(new CustomEvent('heron-ai-template-changed', { detail: { sessionId: id } })) }
    const load = () => loading ??= api('/heron-ai-templates/catalog').finally(() => { loading = null })
    const input = id => ctx.get('conversation')?.input.shell(id)
    ctx.provide('heronAiTemplateForms', { flush: id => pending.get(id) })
    ctx.inject(['conversation'], scope => {
      scope.effect(() => scope.conversation.input.registerBeforeSend(async (sessionId, signal) => {
        await pending.get(sessionId)
        signal.throwIfAborted()
      }), 'heron-ai: save template fields before sending')
    })
    function TemplateControls({ part }) {
      const sessions = React.useSyncExternalStore(ctx.sessions.list.subscribe, ctx.sessions.list.getSnapshot)
      const { sessionId: id } = React.useSyncExternalStore(ctx.uiWorkspace.selection.subscribe, ctx.uiWorkspace.selection.getSnapshot)
      const preset = sessions.byId[id]?.projectionValues?.agentPreset ?? 'standard'
      const running = sessions.byId[id]?.running ?? false
      const blank = sessions.byId[id]?.blank === true
      const available = blank
      const [row, setRow] = React.useState(null), [templates, setTemplates] = React.useState([]), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
      React.useEffect(() => {
        if (!available) { setRow(null); setTemplates([]); setError(''); return }
        let cancelled = false
        const listener = (sessionId, value) => { if (sessionId === id) setRow(value) }; listeners.add(listener)
        setRow(state.get(id) ?? null); setError('')
        Promise.all([load(), id ? api('/heron-ai-templates/session?sessionId=' + encodeURIComponent(id)) : Promise.resolve(null)])
          .then(([catalog, value]) => { if (!cancelled) { setTemplates(catalog.templates); if (value) publish(id, value) } }).catch(failure => { if (!cancelled) setError(failure.message) })
        return () => { cancelled = true; listeners.delete(listener) }
      }, [id, running, available, preset])
      const clear = async () => { setBusy(true); try { publish(id, await api('/heron-ai-templates/session', { sessionId: id, templateId: null })); if (input(id)?.snapshot.draft === row?.selected?.name) input(id).setDraft('') } catch (failure) { setError(failure.message) } finally { setBusy(false) } }
      const select = async (templateId, fieldValues) => {
        setBusy(true); setError('')
        try {
          if (templateId === '$open') { await api('/heron-ai-templates/open', { templateId: row?.selected?.id }); return }
          if (templateId === '$reload') { setTemplates((await load()).templates); return }
          await pending.get(id)
          const next = id
          let value = await api('/heron-ai-templates/session', { sessionId: next, templateId })
          if (fieldValues) value = await api('/heron-ai-templates/session', { sessionId: next, values: { ...value.values, ...fieldValues } }, 'PUT')
          publish(next, value); await ctx.sessions.refresh(); ctx.uiWorkspace.openSession(next)
          if (value.selected.fields.every(field => !field.required || value.values[field.name]?.trim())) input(next)?.setDraft(value.selected.name)
        } catch (failure) { setError(failure.message) } finally { setBusy(false) }
      }
      const change = values => {
        const updated = { ...row, values }; setRow(updated); state.set(id, updated)
        const write = (pending.get(id) ?? Promise.resolve()).catch(() => {}).then(() => api('/heron-ai-templates/session', { sessionId: id, values }, 'PUT'))
          .then(value => { if (state.get(id) === updated) publish(id, value) }).catch(failure => { setError(failure.message); throw failure })
        pending.set(id, write); void write.catch(() => {})
        const ready = updated.selected.fields.every(field => !field.required || String(values[field.name] ?? '').trim())
        if (ready && !input(id)?.snapshot.draft.trim()) input(id)?.setDraft(updated.selected.name)
        if (!ready && input(id)?.snapshot.draft === updated.selected.name) input(id).setDraft('')
      }
      React.useEffect(() => {
        if (part !== 'menu' || !available) return
        const choose = event => { if (event.detail?.templateId) void select(event.detail.templateId, event.detail.values) }
        document.addEventListener('heron-ai-template-select', choose)
        return () => document.removeEventListener('heron-ai-template-select', choose)
      }, [id, preset, part, available])
      if (!available) return null
      return h(Widget, { kind: 'templates', values: { part, templates,
        selected: row?.selected, values: row?.values ?? {}, busy: busy || running, error, select, clear, change } })
    }
    ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({ name: 'conversation.hero.options', id: 'heron-ai-templates', order: -50 }, () => h(TemplateControls, { part: 'menu' })))
    // Last dock row, directly above the input; the new-conversation hero shows the menu in its options row instead.
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'heron-ai-templates-menu', order: 900 },
      () => h('div', { className: 'heron-ai-templates-header' }, h(TemplateControls, { part: 'menu' }))))
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'heron-ai-template-fields', order: -50 }, () => h(TemplateControls, { part: 'form' })))
  }
  return { inject, apply }

    })()
    let widgets
    function Widget({ kind, values }) {
      const root = React.useRef(null), mounted = React.useRef(null), latest = React.useRef(values)
      latest.current = values
      const [error, setError] = React.useState('')
      React.useEffect(() => {
        let disposed = false
        const devServer = window.__HERON_AI_UI_DEV_SERVER__
        if (!devServer && !document.querySelector('link[data-heron-ai-widgets]')) {
          const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = new URL('heron-ai-acp/ui/widgets.css', document.baseURI).href; css.dataset.heronAiWidgets = 'true'; document.head.appendChild(css)
        }
        ;(widgets ??= (devServer
          ? import(devServer + '/@vite/client').then(() => import(devServer + '/src/dsh-widgets.ts'))
          : import(new URL('heron-ai-acp/ui/widgets.js', document.baseURI).href)).catch(error => { widgets = null; throw error })).then(module => {
          if (!disposed) mounted.current = module.mountWidget(root.current, kind, latest.current)
        }).catch(error => { if (!disposed) setError(error.message) })
        return () => { disposed = true; mounted.current?.dispose(); mounted.current = null }
      }, [kind])
      React.useEffect(() => { mounted.current?.update(values) })
      return h('span', { ref: root, className: 'heron-ai-dsh-widget' }, error || null)
    }
    const dismissedCredentials = new Set()
    let credentialOnboardingOffered = false
    function PublicAiCard({ providers }) {
      const offer = credentialPolicy.publicOffer
      const provider = offer && providers.find(provider => provider.provider === offer.provider)
      if (!provider) return null
      return h('article', { className: 'heron-ai-public-card' },
        h('header', { className: 'heron-ai-public-card-title' },
          brandAssets[offer.provider] ? h('img', { src: brandAssets[offer.provider], alt: '', 'aria-hidden': true }) : null,
          h('strong', null, provider.displayName)),
        h('p', { className: 'heron-ai-public-card-offer' }, offer.text))
    }
    // Filled at composition: notices for retired channels, shown in the public card's style.
    const providerNotices = /* HERON_AI_PROVIDER_NOTICES */ []
    function ProviderNoticeCard({ notice }) {
      return h('article', { className: 'heron-ai-public-card', 'data-tone': 'notice' },
        h('header', { className: 'heron-ai-public-card-title' },
          brandAssets[notice.id] ? h('img', { src: brandAssets[notice.id], alt: '', 'aria-hidden': true }) : null,
          h('strong', null, notice.name)),
        h('p', { className: 'heron-ai-public-card-offer' }, notice.text))
    }
    function ModelsHeaderCards({ providers }) {
      const cards = [h(PublicAiCard, { key: 'public', providers }),
        ...providerNotices.map(notice => h(ProviderNoticeCard, { key: notice.id, notice }))]
      return providerNotices.length ? h('div', { className: 'heron-ai-models-header-cards' }, cards) : cards[0]
    }
    // Filled at composition: providers whose card offers an account sign-in. The route answers
    // GET with { phase: idle | pending | signedIn | failed, url?, user?, message? } and POST by starting a login.
    const providerSignIn = /* HERON_AI_PROVIDER_SIGN_IN */ {}
    function ProviderSignIn({ provider, signIn }) {
      const [status, setStatus] = React.useState(null), [error, setError] = React.useState('')
      const read = () => api(signIn.path).then(value => { setStatus(value); setError('') }, failure => setError(failure.message))
      React.useEffect(() => { void read() }, [signIn.path])
      React.useEffect(() => {
        if (status?.phase !== 'pending') return
        const timer = setInterval(read, 2000)
        return () => clearInterval(timer)
      }, [status?.phase])
      const signedIn = status?.phase === 'signedIn'
      React.useEffect(() => {
        if (signedIn) document.dispatchEvent(new CustomEvent('heron-ai-credential-saved', { detail: { provider } }))
      }, [signedIn])
      const start = async () => {
        setError('')
        try {
          const next = await api(signIn.path, {})
          setStatus(next)
          window.open(next.url, '_blank', 'noopener,noreferrer')
        } catch (failure) { setError(failure.message) }
      }
      const pending = status?.phase === 'pending'
      return h('span', { className: 'heron-ai-provider-sign-in' },
        h('button', { type: 'button', className: 'heron-ai-provider-sign-in-button', disabled: pending, onClick: start },
          signedIn ? '重新登录' : signIn.label),
        signedIn ? h('span', { className: 'heron-ai-provider-sign-in-status' }, '已登录' + (status.user ? '：' + status.user : '')) : null,
        pending ? h('span', { className: 'heron-ai-provider-sign-in-status' }, '请在浏览器中完成登录，',
          h('a', { href: status.url, target: '_blank', rel: 'noopener noreferrer',
            onClick: event => { event.preventDefault(); window.open(status.url, '_blank', 'noopener,noreferrer') } }, '未打开浏览器？点此登录')) : null,
        status?.phase === 'failed' ? h('span', { className: 'heron-ai-provider-sign-in-status', role: 'alert' }, status.message) : null,
        error ? h('span', { className: 'heron-ai-provider-sign-in-status', role: 'alert' }, error) : null)
    }
    function CredentialPrompt({ provider, sessionId, selectPersonalModel }) {
      const [request, setRequest] = React.useState(null)
      const requested = React.useRef(null)
      const previous = React.useRef({ provider, sessionId })
      React.useEffect(() => {
        let disposed = false, pending = false
        const switched = previous.current.sessionId === sessionId && previous.current.provider
          && provider && previous.current.provider !== provider
        previous.current = { provider, sessionId }
        if (switched) dismissedCredentials.delete(provider + ':missing')
        requested.current = null; setRequest(null)
        if (!provider) return
        const check = async () => {
          if (pending || requested.current) return
          pending = true
          try {
            if (provider === 'heronAi') {
              const fallback = credentialPolicy.quotaFallback
              if (!fallback) return
              const quota = await api('/heron-ai-acp/public')
              if (!quota.configured || quota.unlimited || !(quota.quota_issue
                  || Number.isFinite(quota.limit_tokens) && quota.used_tokens >= quota.limit_tokens)) return
              const key = `heron-ai:quota:${sessionId}:${quota.quota_issue?.revision ?? quota.limit_tokens}`
              if (dismissedCredentials.has(key)) return
              // Existing personal credentials remain the user's model-menu choice.
              if ((await api('/heron-ai-acp/providers')).anyCredentialConfigured) return
              const row = await api('/heron-ai-acp/credentials?provider=' + encodeURIComponent(fallback.provider))
              if (!disposed) {
                const value = { row, key, provider: fallback.provider, model: quota.model, quotaExhausted: true,
                  message: (quota.quota_issue?.message ?? fallback.exhaustedMessage ?? '免费额度已用完，请配置个人 Token。')
                    + ' ' + fallback.message }
                requested.current = value; setRequest(value)
              }
              return
            }
            const catalog = await api('/heron-ai-acp/providers')
            const noneConfigured = !catalog.anyCredentialConfigured
            if (!noneConfigured) credentialOnboardingOffered = true
            const firstRun = noneConfigured && !credentialOnboardingOffered
            const target = firstRun && !switched && credentialPolicy.firstRun ? credentialPolicy.firstRun
              : ['deepseek-official', ...credentialPolicy.prompted ?? []].includes(provider) ? provider : null
            if (!target) return
            const row = await api('/heron-ai-acp/credentials?provider=' + encodeURIComponent(target))
            const key = !row.credential_configured ? (firstRun || switched ? target + ':missing' : null)
              : row.credentialIssue ? target + ':' + row.credentialIssue.revision : null
            if (!disposed && key && !dismissedCredentials.has(key)) {
              credentialOnboardingOffered = true
              const value = { row, key, provider: target, message: !row.credential_configured ? '请先配置 Token。' : row.credentialIssue.message }
              requested.current = value; setRequest(value)
            }
          } catch {} finally { pending = false }
        }
        void check()
        const timer = setInterval(check, 2000)
        return () => { disposed = true; clearInterval(timer) }
      }, [provider, sessionId])
      if (!request) return null
      return h(Widget, { kind: 'providers', values: { dialogOnly: true, providers: [request.row], busy: false, error: '',
        requestedProvider: request.provider, requestError: request.message, reload: async () => {},
        saveLabel: request.quotaExhausted ? '保存并切换' : undefined,
        dismiss: () => { dismissedCredentials.add(request.key); requested.current = null; setRequest(null) },
        saveToken: async (id, token) => {
          await api('/heron-ai-acp/settings', { provider: id, token }, 'PUT')
          if (request.quotaExhausted) await selectPersonalModel(id, request.model)
          document.dispatchEvent(new CustomEvent('heron-ai-credential-saved', { detail: { provider: id } }))
        },
      } })
    }
    // Filled at composition: business packages name the channel tokens the chat asks for and where an
    // exhausted public quota switches to; colored marks render as images instead of single-color masks.
    const credentialPolicy = /* HERON_AI_CREDENTIAL_POLICY */ {}
    const coloredBrands = /* HERON_AI_COLORED_BRANDS */ []
    const brandAssets = /* HERON_AI_BRAND_ASSETS */ {}
    const brandScales = /* HERON_AI_BRAND_SCALES */ {}
    const inject = ['slots', 'uiConversation', 'uiWorkspace', 'sessions', 'workspaces', 'remote', 'remote.session', 'remote.settings']
    const css = `
      .heron-ai-public-card{display:flex;flex-direction:column;gap:12px;padding:12px 14px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}
      .heron-ai-public-card-title{display:flex;align-items:center;gap:6px;min-height:28px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
      .heron-ai-public-card-title img{width:16px;height:16px;object-fit:contain}
      .heron-ai-public-card-title strong{font-weight:500}
      .heron-ai-public-card-offer{margin:0;color:var(--dsw-alias-state-business-primary);font-size:14px;font-weight:600;line-height:22px}
      .heron-ai-models-header-cards{display:flex;flex-direction:column;gap:12px}
      .heron-ai-public-card[data-tone=notice] .heron-ai-public-card-offer{color:var(--dsw-alias-label-secondary)}
      .heron-ai-provider-card-extras{display:flex;flex-direction:column;align-items:flex-start;gap:8px}
      .heron-ai-provider-sign-in{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
      .heron-ai-provider-sign-in-button{height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}
      .heron-ai-provider-sign-in-button:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover)}
      .heron-ai-provider-sign-in-button:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
      .heron-ai-provider-sign-in-status a{color:var(--dsw-alias-button-primary-fill)}
      .heron-ai-templates-header{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;padding:0 var(--dsh-composer-side-clearance);margin:0 auto}
      .heron-ai-templates-header:empty,[data-phase="hero"] .heron-ai-templates-header{display:none}
      .heron-ai-model-provider-setup{display:block;width:100%;min-height:30px;padding:5px 7px 5px 29px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;text-align:left;cursor:pointer}
      .heron-ai-model-provider-setup:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
      .heron-ai-model-brand{display:inline-block;width:16px;height:16px;flex:none;object-fit:contain}
      .heron-ai-model-brand[data-placement="group"]{width:12px;height:12px;margin:0 0 0 2px}
      [data-menu-group]:has(>[data-menu-group-heading] .heron-ai-model-brand)+[data-menu-group]{margin-top:4px;padding-top:4px;border-top:.5px solid var(--dsw-alias-border-l2)}
      [data-menu-group]:has(>[data-menu-group-heading] .heron-ai-model-brand)>[data-menu-group-heading]{padding-top:6px;padding-bottom:4px;color:var(--dsw-alias-label-secondary)}
      .heron-ai-model-credits{flex:none;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);border-radius:4px;padding:1px 5px;font-size:11px}
      .heron-ai-model-provider-setup:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-border-l3));outline-offset:-2px}
      .heron-ai-mcp-trigger{--heron-ai-mcp-color:var(--dsw-alias-label-tertiary);display:inline-flex;align-items:center;justify-content:center;gap:7px;flex:none;min-height:32px;padding:5px 10px;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;font-weight:600;line-height:20px;white-space:nowrap;cursor:pointer;box-shadow:none}
      .heron-ai-mcp-trigger[data-status=success]{--heron-ai-mcp-color:var(--dsw-alias-state-success-primary,#16a34a)}
      .heron-ai-mcp-trigger[data-status=warning]{--heron-ai-mcp-color:#d99a00}
      .heron-ai-mcp-trigger[data-status=error]{--heron-ai-mcp-color:var(--dsw-alias-state-error-primary,#dc2626)}
      .heron-ai-mcp-trigger:hover{color:var(--dsw-alias-label-secondary)}
      .heron-ai-mcp-trigger:focus-visible{outline:2px solid var(--dsw-alias-label-secondary);outline-offset:2px}
      .heron-ai-mcp-dot{width:8px;height:8px;flex:none;border-radius:50%;background:var(--heron-ai-mcp-color);box-shadow:0 0 0 3px color-mix(in srgb,var(--heron-ai-mcp-color) 15%,transparent)}
      .heron-ai-mcp-action{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}
      [data-heron-ai-acp-mcp=true]>section>div:first-of-type{display:none!important}
    `
    function McpStatusButton({ ctx }) {
      const snapshot = React.useSyncExternalStore(ctx.sessions.list.subscribe, ctx.sessions.list.getSnapshot)
      const { sessionId } = React.useSyncExternalStore(ctx.uiWorkspace.selection.subscribe, ctx.uiWorkspace.selection.getSnapshot)
      const [status, setStatus] = React.useState({ servers: [], loaded: false, error: false })
      React.useEffect(() => {
        let disposed = false
        const read = () => api('/mcp-manager/api/servers').then(value => {
          if (!disposed) setStatus({ servers: value.servers ?? [], loaded: true, error: false })
        }, () => { if (!disposed) setStatus(previous => ({ ...previous, error: true })) })
        void read(); const timer = setInterval(read, 3000)
        return () => { disposed = true; clearInterval(timer) }
      }, [])
      const enabled = status.servers.filter(server => server.enabled !== false)
      const connected = enabled.filter(server => server.status === 'connected').length
      const failed = enabled.filter(server => ['error', 'offline'].includes(server.status)).length
      const total = enabled.length
      const tone = status.error ? 'error' : !status.loaded || !total ? 'neutral'
        : connected === total ? 'success' : failed === total ? 'error' : 'warning'
      const message = status.error ? '状态读取失败' : !status.loaded ? '正在读取状态' : !total ? '没有启用的服务器'
        : connected === total ? '全部连接成功' : failed === total ? '全部连接失败' : failed ? '部分连接失败' : '正在连接'
      const count = !status.loaded || status.error ? '—' : `${connected}/${total}`
      const action = tone === 'warning' || tone === 'error' ? '检查' : total ? '管理' : '配置'
      return h('button', { type:'button', className:'heron-ai-mcp-trigger', 'data-status':tone,
        title:`${message}；${connected}/${total} 个已启用服务器已连接。点击管理 MCP`,
        'aria-label':`MCP ${count}，${message}，点击管理 MCP`,
        onClick:() => ctx.get('settingsShell')?.open('mcp-manager') },
        h('span', {className:'heron-ai-mcp-dot', 'aria-hidden':true}),
        h('span', null, `MCP ${count}`), h('span', {className:'heron-ai-mcp-action', 'aria-hidden':true}, action))
    }
    function installMobilePresentation(ctx) {
      const icon = path => h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true },
        h('path', { d: path, strokeLinecap: 'round', strokeLinejoin: 'round' }))
      function Header({ renderSlot }) {
        return h('div', { className: 'heron-ai-mobile-header' },
          h('button', { className: 'heron-ai-mobile-icon', type: 'button', 'aria-label': '会话列表', onClick: () => ctx.layout.showSidebar() },
            icon('M4 6h16M4 12h16M4 18h16')),
          h('span', { className: 'heron-ai-mobile-title' }, 'AI 助手'),
          h('div', { className: 'heron-ai-mobile-header-actions' }, h(McpStatusButton, { ctx }),
            h('button', { className: 'heron-ai-mobile-icon', type: 'button', 'aria-label': '设置', onClick: () => ctx.settingsShell.open('general') },
              icon('M4 7h16M4 17h16M8 4v6M16 14v6')),
            renderSlot('heronAi.mobile.header.action', {})))
      }
      function Controls({ commands, fileInput, permission, plan, left, right, model, activity, meter, submit, expanded }) {
        // TODO(HeronAiMobile 图片): 在“添加”菜单增加独立的“图片”入口，用独立的 image/*
        // 选择请求接入现有附件上传。必须与 Kuikly/Android 的 onShowFileChooser 协同，
        // 真机验证系统图片选择器、单/多选、取消、URI 回传和上传预览后再启用；
        // 当前只保留“文件”入口，不能把普通文件选择器当作图片功能交付。
        return h('div', { className: 'heron-ai-mobile-controls' }, fileInput,
          !expanded && commands,
          !expanded && h('div', { className: 'heron-ai-mobile-permission' }, permission),
          !expanded && h('div', { className: 'heron-ai-mobile-extras' }, plan, left, right, meter),
          !expanded && h('div', { className: 'heron-ai-mobile-model' }, model),
          h('div', { className: 'heron-ai-mobile-submit', 'data-expanded': expanded || undefined }, activity, submit))
      }
      const ModelLabel = ({ model }) => model.name.replace(/^[^/]+\/\s*/, '').trim()
      for (const [name, component] of [['conversation.header.leading', Header], ['conversation.input.controls', Controls],
        ['conversation.input.model.label', ModelLabel]]) {
        ctx.slots.inject(name, () => {
          let release
          const update = () => {
            const enabled = phoneMedia.matches && !window.__HERON_AI_SESSION_VIEW__
            if (enabled && !release) release = ctx.slots.register({ name, id: 'heron-ai-mobile-presentation', priority: -200,
              ...(name === 'conversation.header.leading' ? { children: { 'heronAi.mobile.header.action': { kind: 'list', scope: 'root' } } } : {}) }, component)
            else if (!enabled && release) { release(); release = undefined }
          }
          update(); phoneMedia.addEventListener('change', update)
          return () => { phoneMedia.removeEventListener('change', update); release?.() }
        })
      }
    }
    async function api(path, body, method = 'POST') {
      const response = await fetch(new URL(path.replace(/^\/+/, ''), document.baseURI), { credentials: 'same-origin', ...(body ? {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      } : {}) })
      const text = await response.text()
      let value
      try { value = text ? JSON.parse(text) : {} }
      catch { throw new Error('设置服务暂时不可用，请刷新页面后重试') }
      if (!response.ok) throw new Error(value.error ?? 'ACP request failed')
      if (!text) throw new Error('设置服务返回为空，请刷新页面后重试')
      return value
    }
    function apply(ctx) {
      installWorkspaceProjects(ctx, React)
      installHeronAiThemes(ctx, React)
      ctx.provide('heronAiWidgets', { Widget, api })
      templatesPlugin.apply(ctx)
      const sharedProvider = provider => globalThis.__HERON_AI_DSH_PROVIDERS__?.some(item => item.id === provider.id && item.public)
      ctx.inject(['settingsShell'], scope => {
        scope.slots.inject('conversation.input.model.provider-setup', () => scope.slots.register({
          name: 'conversation.input.model.provider-setup', id: 'heron-ai-provider-setup',
        }, ({ provider, close }) => h('button', {
          type: 'button', role: 'menuitem', className: 'heron-ai-model-provider-setup',
          'aria-label': sharedProvider(provider) ? '查看公共额度' : `配置 ${provider.name} Token`,
          onKeyDown: event => { if (event.key !== 'Escape') event.stopPropagation() },
          onClick: () => { close(); scope.settingsShell.open('models') },
        }, sharedProvider(provider) ? '公共额度' : '配置 Token')))
      })
      // Model menu: brand marks, credit multipliers and the provider-qualified caption.
      // Group headings space their icon 8px from the label, options 6px; the heading icon gives back 2px so the
      // provider name lines up with the model names below it.
      const ModelBrand = ({ provider, model, placement }) => {
        const key = model?.metadata?.brand ?? provider?.id
        const id = key === 'deepseek-official' || key === 'deepseek-account' ? 'deepseek' : key
        const source = id === undefined ? undefined : brandAssets[id]
        const shared = { className: 'heron-ai-model-brand', 'data-placement': placement, 'aria-hidden': true }
        if (!source) return h(Ui.IconDataOutlineRegular, { ...shared, size: 16 })
        const transform = `scale(${brandScales[id] ?? 0.8})`
        return coloredBrands.includes(id)
          ? h('img', { ...shared, style: { transform }, src: source, alt: '' })
          : h('span', { ...shared, style: { transform, background: 'currentColor',
            maskImage: `url("${source}")`, WebkitMaskImage: `url("${source}")`, maskSize: 'contain', maskRepeat: 'no-repeat', maskPosition: 'center' } })
      }
      ctx.slots.inject('conversation.input.model.icon', () => ctx.slots.register({
        name: 'conversation.input.model.icon', id: 'heron-ai-model-brand',
      }, ModelBrand))
      ctx.slots.inject('conversation.input.model.badge', () => ctx.slots.register({
        name: 'conversation.input.model.badge', id: 'heron-ai-model-credits',
      }, ({ model }) => typeof model.metadata?.credits !== 'number' ? null : h('span', { className: 'heron-ai-model-credits' }, `x${model.metadata.credits.toFixed(2)}`)))
      ctx.slots.inject('conversation.input.model.label', () => ctx.slots.register({
        name: 'conversation.input.model.label', id: 'heron-ai-model-provider-label',
      }, ({ provider, model, placement }) => placement === 'option' ? model.name : `${provider.name} / ${model.name}`))
      ctx.slots.inject('settings.models.credential-prompt', () => ctx.slots.register({
        name: 'settings.models.credential-prompt', id: 'heron-ai-native-token',
      }, ({ provider, displayName, save, close }) => h(Widget, { kind: 'providers', values: {
        dialogOnly: true, busy: false, error: '', requestedProvider: provider,
        providers: [{ id: provider, credential: { label: `${displayName || 'DeepSeek'} Token`,
          placeholder: 'sk-…', help_url: 'https://platform.deepseek.com/api_keys', help_label: 'DeepSeek API Keys' } }],
        requestError: '请先配置 Token。', dismiss: close, saveToken: (_provider, token) => save(token),
      } })))
      // The host opens external links from its WebView2 NewWindowRequested handler.
      // An anchor's own target=_blank navigation is not always delivered there (it
      // varies with the WebView2 runtime), so route clicks through window.open(),
      // which reliably reaches the handler from a user gesture.
      // Filled at composition from the bundled provider catalog's credential help links.
      const credentialHelp = /* HERON_AI_CREDENTIAL_HELP */ {}
      ctx.slots.inject('settings.models.header', () => ctx.slots.register({
        name: 'settings.models.header', id: 'heron-ai-public-card',
      }, ModelsHeaderCards))
      for (const key of ['heron-ai-llm-pi-ai', 'llm-deepseek'])
        ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({ name: 'settings.models.provider-card', key },
          ({ provider }) => {
            const help = credentialHelp[provider.provider], signIn = providerSignIn[provider.provider]
            const line = help ? h('span', { style: { fontSize: 14, color: 'var(--dsw-alias-label-secondary)' } },
              '没有 Token？前往 ', h('a', { href: help.url, target: '_blank', rel: 'noopener noreferrer',
                onClick: event => { event.preventDefault(); window.open(help.url, '_blank', 'noopener,noreferrer') },
                style: { color: 'var(--dsw-alias-button-primary-fill)' } }, help.label), ' 获取。') : null
            return signIn ? h('div', { className: 'heron-ai-provider-card-extras' }, h(ProviderSignIn, { provider: provider.provider, signIn }), line) : line
          }))
      for (const name of ['conversation.session.header.utilities', 'conversation.hero.options']) {
        ctx.slots.inject(name, () => ctx.slots.register({
          name, id: 'heron-ai-mcp-manager', order: name === 'conversation.hero.options' ? 50 : -20,
        }, () => usePhone() && !window.__HERON_AI_SESSION_VIEW__ ? null : h(McpStatusButton, { ctx })))
      }
      ctx.inject(['layout', 'settingsShell'], installMobilePresentation)
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = '@heron-ai/dsh-heron-ai'
        tag.dataset.pluginCss = '@heron-ai/dsh-heron-ai/controls.css'
        tag.textContent = css
        document.head.appendChild(tag)
        return () => tag.remove()
      })
      // Retain the recent selection across DSH's per-process random ports, as in
      // FL's direct client. This changes navigation only, never sends a prompt.
      ctx.effect(() => {
        let saved = window.__HERON_AI_DSH_NAVIGATION__?.sessionId, pending = Promise.resolve()
        const persist = () => {
          const state = ctx.sessions.list.getSnapshot()
          if (state.phase !== 'ready') return
          const selected = ctx.uiWorkspace.selection.getSnapshot()
          const sessionId = selected.sessionId
          if (sessionId === saved) return
          saved = sessionId
          pending = pending.then(() => ctx.remote.settings.mutate('heron-ai-navigation', [sessionId
            ? { op: 'set', path: ['sessionId'], value: sessionId }
            : { op: 'unset', path: ['sessionId'] }], undefined)).catch(() => {})
        }
        const unsubscribe = ctx.uiWorkspace.selection.subscribe(persist)
        const stopList = ctx.sessions.list.subscribe(persist)
        return () => { unsubscribe(); stopList() }
      })
      function SelectedModelCredential({ useProjection, sessionId }) {
        const projected = useProjection('modelSelection')
        const [fallback, setFallback] = React.useState(null)
        React.useEffect(() => {
          let disposed = false
          void ctx.remote.session.modelCatalog().then(result => {
            if (!disposed && result.ok) setFallback(result.value.default.provider)
          }).catch(() => {})
          return () => { disposed = true }
        }, [sessionId])
        const provider = projected?.next?.provider ?? fallback
        return h(CredentialPrompt, { provider, sessionId, selectPersonalModel: async (target, model) => {
          const result = await ctx.remote.session.selectModel({ sessionId, provider: target, model })
          if (!result.ok) throw Error('Token 已保存，切换模型失败：' + result.error.message)
        } })
      }
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: 'heron-ai-model-credentials', order: 100,
      }, SelectedModelCredential))

    }
    return { inject, apply }
  },
})
