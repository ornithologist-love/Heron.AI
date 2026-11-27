window.__ModuleLoader__.load({
  id: 'dsh-google-connector',
  factory: require => {
    const React = require('react')
    const { Button, IconChevronRightOutlineRegular, Switch } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const id = 'google-connector'
    // Google G from https://developers.google.com/static/identity/images/g-logo.png
    const icon = 'data:image/png;base64,' +
      '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'
    const zh = {
      description: '连接 Drive、Docs、Sheets、Slides、Calendar 和 Gmail',
      loading: '加载中…',
      unavailable: '请在本机 Heron.AI 窗口配置 Google Suite',
      unavailableState: '连接异常',
      disconnected: '未连接',
      connectingState: '等待授权',
      connecting: '请在浏览器完成 Google 授权',
      connected: '已连接',
      groupStatus: '已连接 {n}/{total} 项',
      configure: '配置',
      connect: '连接',
      updateAuthorization: '更新授权',
      needsConsent: '需要授权',
      ready: '已就绪',
      cancel: '取消',
      copyAuthLink: '复制授权链接',
      copiedAuthLink: '已复制，请粘贴到浏览器',
      openAuthManually: '自动打开失败，请把授权链接粘贴到浏览器。',
      disconnect: '断开连接',
      setup: '打开 Google Cloud',
      setupHelp: '首次使用需导入从 Google Cloud 下载的桌面应用客户端 JSON。',
      importClient: '导入客户端 JSON',
      invalidClient: '请导入从 Google Cloud 下载的桌面应用客户端 JSON。',
      readFailed: '无法读取选中的文件，请重新选择下载的 JSON。',
      browserFailed: '无法打开系统浏览器。',
      failed: '操作失败，请重试。',
      servicesTitle: '包含服务',
    }
    const en = {
      description: 'Connect Drive, Docs, Sheets, Slides, Calendar, and Gmail',
      loading: 'Loading…',
      unavailable: 'Configure Google Suite in the local Heron.AI window',
      unavailableState: 'Connection error',
      disconnected: 'Disconnected',
      connectingState: 'Awaiting authorization',
      connecting: 'Finish authorization in your browser',
      connected: 'Connected',
      groupStatus: '{n} of {total} connected',
      configure: 'Configure',
      connect: 'Connect',
      updateAuthorization: 'Update authorization',
      needsConsent: 'Authorization required',
      ready: 'Ready',
      cancel: 'Cancel',
      copyAuthLink: 'Copy authorization link',
      copiedAuthLink: 'Copied. Paste into your browser.',
      openAuthManually: 'Could not open the browser. Paste the authorization link into your browser.',
      disconnect: 'Disconnect',
      setup: 'Open Google Cloud',
      setupHelp: 'First-time setup requires importing a desktop OAuth client JSON from Google Cloud.',
      importClient: 'Import client JSON',
      invalidClient: 'Import the desktop client JSON downloaded from Google Cloud.',
      readFailed: 'Could not read this file. Select the downloaded JSON again.',
      browserFailed: 'Could not open the system browser.',
      failed: 'Could not complete the request. Try again.',
      servicesTitle: 'Services',
    }

    async function request(body, signal) {
      const response = await fetch(new URL('heron-ai-google-connector', document.baseURI), {
        credentials: 'same-origin',
        signal,
        ...(body === undefined ? {} : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Heron-Google-Connector': '1' },
          body: JSON.stringify(body),
        }),
      })
      const value = await response.json().catch(() => null)
      if (!response.ok) throw new Error(value?.code ?? `HTTP ${response.status}`)
      return value
    }

    async function readClient(file) {
      const contents = await file.text().catch(() => { throw new Error('readFailed') })
      try { return JSON.parse(contents) } catch { throw new Error('invalidClient') }
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(id, { zh, en }))
      const t = ctx.locale.bind(id)
      ctx.effect(() => {
        const style = document.createElement('style')
        style.textContent = `
          .heron-google-notice{display:grid;gap:8px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-settings-card-fill);font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary)}
          .heron-google-notice p{margin:0}
          .heron-google-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
          .heron-google-auth-link{box-sizing:border-box;width:100%;max-width:460px;height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
          .heron-google-meta{color:var(--dsw-alias-label-secondary)}
          .heron-google-error{color:var(--dsw-alias-state-error-primary)}
        `
        document.head.append(style)
        return () => style.remove()
      })

      function ConnectorPanel({ activeDetailId, openDetail, renderConnector, renderDetail }) {
        const [status, setStatus] = React.useState(null)
        const [unavailable, setUnavailable] = React.useState(false)
        const [error, setError] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const [copyState, setCopyState] = React.useState('')
        const clientFile = React.useRef(null)
        const connecting = status?.connecting === true
        const services = status?.services ?? []
        const hasEnabledService = services.some(service => service.enabled)
        const needsAuthorization = services.some(service => service.enabled && !service.authorized)
        const enabledReadyCount = services.filter(service => service.enabled && service.authorized).length

        React.useEffect(() => {
          const controller = new AbortController()
          request(undefined, controller.signal).then(setStatus, () => {
            if (!controller.signal.aborted) setUnavailable(true)
          })
          return () => controller.abort()
        }, [])

        React.useEffect(() => {
          if (!connecting) return
          const controller = new AbortController()
          const timer = setInterval(() => {
            request(undefined, controller.signal).then(setStatus, () => {})
          }, 1000)
          return () => { clearInterval(timer); controller.abort() }
        }, [connecting])

        async function action(actionName, { file, ...fields } = {}) {
          setBusy(true)
          setError('')
          setCopyState('')
          try {
            if (file && file.size > 8192) throw new Error('invalidClient')
            const client = file && await readClient(file)
            const next = await request({ action: actionName, ...fields, ...(file && { client }) })
            setStatus(next)
            return next
          } catch (failure) {
            const code = failure.message
            setError(['invalidClient', 'readFailed', 'browserFailed'].includes(code) ? t(code) : t('failed'))
          } finally {
            if (file && clientFile.current) clientFile.current.value = ''
            setBusy(false)
          }
        }

        async function copyAuthorizationUrl() {
          const url = status.authorizationUrl ?? (await action('copy-link'))?.authorizationUrl
          if (!url) return
          try {
            await navigator.clipboard.writeText(url)
            setCopyState('copied')
          } catch { setCopyState('select') }
        }

        const problem = error || status?.error
        const tone = unavailable || problem ? 'error'
          : connecting || !status ? 'connecting'
            : status.connected ? 'connected' : 'disconnected'

        const statusText = !status ? t(unavailable ? 'unavailableState' : 'loading')
          : connecting ? t('connectingState')
            : status.connected
              ? t('groupStatus').replace('{n}', String(enabledReadyCount)).replace('{total}', String(services.length))
              : t('disconnected')

        // Outer grid card: always equal-height with a single clean affordance
        if (activeDetailId !== id) {
          if (activeDetailId !== null) return null
          const cardAction = status?.configured && !connecting && !status.connected
            ? h(Button, {
              variant: 'primary',
              size: 'sm',
              disabled: busy || !hasEnabledService,
              onClick: () => action('connect'),
            }, t('connect'))
            : connecting
              ? h(Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => action('cancel') }, t('cancel'))
              : h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '2px', font: 'var(--dsw-font-xxs-12)', color: 'var(--dsw-alias-label-secondary)' } },
                t('configure'),
                h(IconChevronRightOutlineRegular, { size: 14 }))

          return renderConnector({
            id,
            name: 'Google Suite',
            icon,
            description: t('description'),
            status: statusText,
            tone,
            actions: cardAction,
            onOpen: () => openDetail(id),
          })
        }

        // In-page detail view
        const primaryActions = !status ? null : status.configured
          ? h(React.Fragment, null,
            connecting
              ? h(Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => action('cancel') }, t('cancel'))
              : status.connected
                ? h(Switch, {
                  checked: true,
                  disabled: busy,
                  label: 'Google Suite',
                  onChange: () => action('disconnect'),
                })
                : h(Button, {
                  variant: 'primary',
                  size: 'sm',
                  disabled: busy || !hasEnabledService,
                  onClick: () => action('connect'),
                }, t('connect')))
          : h(React.Fragment, null,
            h('input', {
              hidden: true,
              type: 'file',
              accept: '.json,application/json',
              ref: clientFile,
              onChange: event => {
                const file = event.currentTarget.files[0]
                if (file) void action('import-client', { file })
              },
            }),
            h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => clientFile.current?.click() }, t('importClient')),
            h(Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => action('open-setup') }, t('setup')))

        const notice = (unavailable || problem || connecting || (status && !status.configured))
          ? h('div', { className: 'heron-google-notice' },
            unavailable && h('p', { className: 'heron-google-meta' }, t('unavailable')),
            problem && h('p', { role: 'alert', className: 'heron-google-error' }, problem),
            connecting && h('p', { role: 'status', className: 'heron-google-meta' }, t(status.browserFailed ? 'openAuthManually' : 'connecting')),
            (connecting || (status?.configured && (!status.connected || needsAuthorization))) && h('div', { className: 'heron-google-actions' },
              h(Button, {
                variant: 'outline',
                size: 'sm',
                disabled: busy || !hasEnabledService,
                onClick: copyAuthorizationUrl,
              }, t(copyState === 'copied' ? 'copiedAuthLink' : 'copyAuthLink'))),
            connecting && status.authorizationUrl && copyState === 'select' && h('input', {
              readOnly: true,
              value: status.authorizationUrl,
              className: 'heron-google-auth-link',
              'aria-label': t('copyAuthLink'),
              onFocus: e => e.currentTarget.select(),
            }),
            status && !status.configured && h('p', { className: 'heron-google-meta' }, t('setupHelp')))
          : null

        const serviceLabels = new Map(services.map(service => [service.toolset, service.label]))
        const detailServices = services.map(({ id: serviceId, label, enabled, authorized }) => ({
          id: serviceId,
          name: label,
          meta: enabled ? t(authorized ? 'ready' : 'needsConsent') : t('disconnected'),
          actions: h(Switch, {
            checked: enabled,
            label,
            disabled: busy || connecting,
            onChange: active => action('set-service', { service: serviceId, enabled: active }),
          }),
        }))

        const detailTools = (status?.tools ?? []).map(tool => ({
          name: tool.name,
          description: tool.description,
          tag: serviceLabels.get(tool.toolset),
        }))

        const maintenance = status?.configured && (status.connected || needsAuthorization)
          ? h(React.Fragment, null,
            needsAuthorization && h(Button, {
              variant: 'outline',
              size: 'sm',
              disabled: busy || !hasEnabledService,
              onClick: () => action('connect'),
            }, t('updateAuthorization')),
            status.connected && h(Button, {
              variant: 'outline',
              size: 'sm',
              disabled: busy,
              onClick: () => action('disconnect'),
            }, t('disconnect')))
          : null

        return renderDetail({
          id,
          name: 'Google Suite',
          icon,
          description: t('description'),
          status: statusText,
          tone,
          actions: primaryActions,
          notice,
          services: detailServices,
          servicesTitle: t('servicesTitle'),
          tools: detailTools,
          maintenance,
        })
      }

      ctx.slots.inject('settings.connectors.card', () => ctx.slots.register({
        name: 'settings.connectors.card',
        id,
      }, ConnectorPanel))
    }

    return { inject: ['locale', 'slots'], apply }
  },
})
