import { renamedIdentifier } from '../migration/branding.mjs'
import { is_model_provider } from './runtime/providers.mjs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { isCredentialFailure } from './credential-errors.mjs'
import { ProviderRegistry } from './runtime/providers-runtime.mjs'
import { ai_provider_definitions, provider_capabilities } from './runtime/providers.mjs'
import { createModelGateway } from './model-gateway.mjs'
import { productIntegrations } from '../integrations.mjs'

export const inject = ['llm', 'credentials']
export const backendPreset = id => `heron-ai-acp-${id}`
export const backendId = preset => ai_provider_definitions.find(item => backendPreset(item.id) === renamedIdentifier(preset))?.id
export const publicStatus = item => ({ ...item, revision: item.revision ? createHash('sha256').update(item.revision).digest('hex') : '' })
// A business preset cites one delegated default, so a model its host rejects (a
// preset-backed provider route, an account-bound host) stays out of reach. A
// channel-unservable model is excluded for the same reason: automation must not
// pick a route whose every send fails.
export const delegatedModelRoutes = catalog => ai_provider_definitions
  .filter(definition => definition.transport === 'llm' && definition.llm
    && !definition.public)
  .flatMap(definition => (catalog.providers?.[definition.id]?.models ?? [])
    .filter(model => model.heron_ai_agent_unsupported !== true)
    .map(model => ({ provider: definition.id, model: model.id })))

export async function apply(ctx, config) {
  config = { ...config, credentialRoot: config.credentialRoot ?? config.stateDir }
  const modelGateway = createModelGateway(ctx, config.automation ? undefined : config.modelGatewayUrl ?? process.env.HERON_AI_MODEL_GATEWAY_URL,
    { allowLocal: config.modelGatewayMode === 'remote' })
  const integrations = new Map(), owners = new Map()
  ctx.effect(() => async () => {
    for (const value of integrations.values()) for (const transport of value.transports.values()) await transport?.close?.()
    integrations.clear()
  }, 'provider integrations: lifetime')
  const registry = new ProviderRegistry({ stateDirectory: config.stateDir, hostRoot: config.hostRoot,
    catalogUrl: config.providerCatalogUrl, legacyConfigRoot: config.localRoot,
    onStatusChanged: providers => process.stdout.write(JSON.stringify({ event: 'providers', providers: providers.map(publicStatus) }) + '\n') })
  // An explicit credential root allows isolated AIHost development to reuse
  // existing credentials read-only. Saving always writes to this host's state.
  const resolveSettings = registry.resolveSettingsFile.bind(registry)
  registry.resolveSettingsFile = filename => {
    const local = registry.settingsPath(filename)
    if (fs.existsSync(local)) return local
    const existing = path.join(config.credentialRoot, 'providers', filename)
    return fs.existsSync(existing) ? existing : resolveSettings(filename)
  }
  const service = { registry, modelGateway, capabilities: new Map(), credentialIssues: new Map(), options: config,
    providerTransport(id) { return integrations.get(registry.definition(id)?.integration ?? owners.get(id))?.transports.get(id) },
    async providerStatus(id) { return await this.providerTransport(id)?.status?.() ?? { configured: false } },
    credentialReference(id) {
      return credentialRef('HERON_AI_' + id.toUpperCase() + '_TOKEN')
    },
    async credentialConfigured(id) {
      const definition = registry.definition(id)
      if (definition?.public) return (await this.providerStatus(id)).configured === true
      const owner = definition?.integration ?? owners.get(id)
      if (owner && !integrations.has(owner)) return false
      return (await ctx.credentials.describe(this.credentialReference(id))).configured
    },
    async saveToken(id, token) {
      await ctx.credentials.set(this.credentialReference(id), token)
      this.credentialIssues.delete(id)
    },
    requireCredential(id) {
      if (!registry.definition(id)?.credential) return
      this.credentialIssues.set(id, { revision: Date.now(), message: 'Token 无效或已过期，请重新配置。' })
    },
    provider_capabilities(id) {
      const declared = provider_capabilities(id)
      const actual = this.capabilities.get(id)
      return { ...declared, sessions: actual
        ? (actual.loadSession || actual.sessionCapabilities?.resume ? 'native' : 'local')
        : declared.sessions }
    } }
  let routes = {}, remoteRoutes = {}
  const routeListeners = new Set()
  Object.defineProperty(service, 'routes', { get: () => routes })
  Object.defineProperty(service, 'remoteRoutes', { get: () => remoteRoutes })
  service.observeRoutes = listener => { routeListeners.add(listener); return () => routeListeners.delete(listener) }
  const dropRoute = id => {
    modelGateway?.removeProvider(id)
    const { [id]: removedRemote, ...remainingRemote } = remoteRoutes
    remoteRoutes = remainingRemote
    if (!Object.hasOwn(routes, id)) return
    const { [id]: removed, ...next } = routes
    routes = next
    for (const listener of routeListeners) listener()
  }
  service.syncModels = async id => {
    const definition = registry.definition(id)
    if (!definition?.llm) return
    const owner = definition.integration ?? owners.get(id)
    if (owner && !integrations.has(owner)) { dropRoute(id); return }
    const custom = service.providerTransport(id)?.modelRoute
    const catalog = await registry.loadProviderCatalog(id), gatewayEndpoint = modelGateway?.endpoint(definition, catalog)
    const endpoint = modelGateway?.exclusive ? gatewayEndpoint
      : custom ? { api: custom.api, baseUrl: custom.baseURL } : definition.public ? undefined : registry.endpoint(definition, catalog)
    const ref = credentialRef('HERON_AI_' + id.toUpperCase() + '_TOKEN')
    const profile = (target, gateway) => ({ displayName: definition.name,
      ...(gateway ? { headers: { Authorization: 'Bearer gateway' } }
        : custom ? { headers: custom.headers, retryPolicy: custom.retryPolicy } : { apiKeyEnv: ref }),
      api: target.api, baseURL: target.baseUrl, compat: { supportsDeveloperRole: false, ...catalog.compat },
      // A model the channel cannot serve for agent work never becomes a route,
      // so no picker lists it and a saved selection falls back to the default.
      models: catalog.models.filter(model => model.heron_ai_agent_unsupported !== true).map(model => ({ id: model.id, name: model.name,
        contextWindow: model.context_window ?? 131072, maxTokens: model.max_tokens ?? 8192,
        input: model.heron_ai_multimodal ? ['text', 'image'] : ['text'],
        reasoningEfforts: model.heron_ai_effort?.length ? Object.fromEntries([['off', null], ...model.heron_ai_effort.map(x => [x,x])]) : false })) })
    if (gatewayEndpoint) remoteRoutes = { ...remoteRoutes, [id]: profile(gatewayEndpoint, true) }
    else { const { [id]: removed, ...remaining } = remoteRoutes; remoteRoutes = remaining }
    if (!endpoint) { dropRoute(id); return }
    routes = { ...routes, [id]: profile(endpoint, modelGateway?.exclusive) }
    for (const listener of routeListeners) listener()
  }
  service.registerProviderIntegration = async ({ id, providers, createTransport, startup = false }) => {
    const existing = integrations.get(id)
    if (existing && !existing.claimed && !startup && JSON.stringify(existing.providers) === JSON.stringify(providers)) {
      existing.claimed = true
      return existing.dispose
    }
    if (typeof id !== 'string' || !id || existing || !Array.isArray(providers)
        || new Set(providers).size !== providers.length || providers.some(name => typeof name !== 'string' || !name)
        || typeof createTransport !== 'function') throw Error('Invalid or duplicate provider integration')
    for (const name of providers) if (owners.has(name) && owners.get(name) !== id) throw Error('Provider already owned by another integration: ' + name)
    const value = { transports: new Map(), providers: [...providers], claimed: !startup }
    integrations.set(id, value)
    const dispose = async () => {
      if (integrations.get(id) !== value) return
      integrations.delete(id)
      for (const name of providers) dropRoute(name)
      for (const transport of value.transports.values()) await transport?.close?.()
    }
    value.dispose = dispose
    try {
      for (const name of providers) {
        owners.set(name, id)
        value.transports.set(name, await createTransport(name, config))
      }
      await Promise.all(providers.map(name => service.syncModels(name)))
      return dispose
    } catch (error) { await dispose(); throw error }
  }
  // Prepare selected transports before publishing the service: automated
  // requests may arrive as soon as dependent plugins mount. The package's
  // runtime entry then adopts the resource and owns its live enable/disable.
  for (const { id, module } of await productIntegrations()) {
    if (!module.providers || !module.createTransport) continue
    await service.registerProviderIntegration({ id, providers: module.providers,
      createTransport: provider => module.createTransport(provider, config), startup: true })
  }
  ctx.provide('heronAiAcp', service)
  registry.onCatalogChanged = id => { void service.syncModels(id).catch(() => {}) }
  ctx.effect(() => {
    const timer = setInterval(() => { void registry.directory.load() }, 5000)
    timer.unref()
    return () => { clearInterval(timer); registry.releaseDirectory() }
  }, 'provider-directory: catalog refresh')
  ctx.on('credentials/reference-updated', ref => {
    for (const definition of ai_provider_definitions.filter(x => x.llm))
      if (service.credentialReference(definition.id) === ref) service.credentialIssues.delete(definition.id)
  })
  await Promise.all(ai_provider_definitions.filter(x => x.llm).map(async definition => {
    try { await service.syncModels(definition.id) }
    catch { await registry.probe(definition.id) }
  }))
  ctx.on('agent/request-error', async (payload, next) => {
    if ((!modelGateway || !modelGateway.requiresPersonalGrant(payload.agent.session.id)) && is_model_provider(payload.provider) &&
      (/CREDENTIAL|AUTH/.test(payload.failure?.code ?? '') || isCredentialFailure(payload.failure))) service.requireCredential(payload.provider)
    return next()
  })
}
