import { defaultSelection } from './acp/runtime/providers.mjs'
export const inject = ['agentDefaultModel', 'settings', 'heronAiAcp']

// This is a deployment default, not request retry or a replacement for a saved choice.
export const productDefault = { get provider() { return defaultSelection()?.provider }, get model() { return defaultSelection()?.model } }

export function apply(ctx) {
  const service = ctx.agentDefaultModel
  const original = service.currentSelection
  const selection = () => {
    const saved = ctx.settings.describe().find(item => item.ns === 'agent-default-model')?.user
    if (saved?.provider !== undefined || saved?.model !== undefined) return original.call(service)
    return defaultSelection(ctx.heronAiAcp.options.preferPublicDefault === true) ?? original.call(service)
  }
  ctx.effect(() => {
    service.currentSelection = selection
    return () => { if (service.currentSelection === selection) service.currentSelection = original }
  }, 'heron-ai-default-model.policy')
}
