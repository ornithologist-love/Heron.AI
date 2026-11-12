// One native adapter combines the deployment catalog and editable provider profiles.
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'

export const Config = PiAi.Config
export const inject = ['llm', 'heronAiAcp', 'settings']
export function apply(ctx, config) {
  let lastUser, lastDeployment, current
  const declared = config.providers
  // Keep the loader's volatile reference protocol, including updates, while
  // exposing the same resolved routes to the adapter and Settings.describe.
  const providers = Object.create(declared)
  Object.defineProperty(providers, 'get', { value: () => {
    const user = declared.get(), deployment = ctx.heronAiAcp.routes
    if (current === undefined || user !== lastUser || deployment !== lastDeployment) {
      lastUser = user; lastDeployment = deployment
      current = Object.freeze(ctx.heronAiAcp.modelGateway ? { ...deployment } : { ...user, ...deployment })
    }
    return current
  } })
  config.providers = providers
  PiAi.apply(ctx, config)
  ctx.effect(() => ctx.heronAiAcp.observeRoutes(() => {
    ctx.emit('loader/volatile-update', [['providers']])
    const descriptor = ctx.settings.describe().find(item => item.ns === ctx.fiber.entry.options.id)
    if (descriptor) ctx.emit('settings/document-updated', descriptor.ns, descriptor.revision)
  }), 'heron-ai-native-models.catalog')
}
