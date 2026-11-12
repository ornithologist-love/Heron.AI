import WebRuntime, { WebError } from '@deepseek-ai/dsh-web'

export const Config = WebRuntime.Config
export const name = 'heron-ai-provider-web'

// Keep the native registry, result bounds and configuration schema. Select a backend inside
// the initiating Agent's async scope, never from a global current-model value.
// Business packages route their model channels to their own web backends through
// `providerWeb.register(providerId, backend)`.
export function apply(ctx, config) {
  const routes = new Map() // model channel id -> web backend id
  const selection = (kind, configured) => {
    const value = Object.create(configured)
    Object.defineProperty(value, 'get', { value: () => {
      const provider = ctx.get('agents')?.currentInitiator()?.session.requestContext()?.provider
      if (routes.has(provider)) return routes.get(provider)
      if (provider === 'deepseek-official' || provider === 'deepseek-account') return configured.get()
      throw new WebError(provider ? `当前模型通道 ${provider} 尚未接入自己的${kind}服务。`
        : `当前调用缺少模型通道，无法选择${kind}服务。`, 'WEB_PROVIDER_UNAVAILABLE')
    } })
    return value
  }
  const web = new WebRuntime(ctx, {
    searchProvider: selection('搜索', config.searchProvider),
    fetchProvider: selection('网页抓取', config.fetchProvider),
  })
  ctx.provide('providerWeb', {
    // backend: a dsh-web search and fetch provider. Returns a disposer.
    register(providerId, backend) {
      if (routes.has(providerId)) throw Error(`模型通道 ${providerId} 已有联网服务`)
      routes.set(providerId, backend.id)
      const search = web.registerSearchProvider(backend)
      const fetch = web.registerFetchProvider(backend)
      return () => { routes.delete(providerId); search(); fetch() }
    },
  })
}
