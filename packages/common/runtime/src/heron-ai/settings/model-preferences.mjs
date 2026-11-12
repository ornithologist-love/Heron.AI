import z from '@deepseek-ai/schemastery'
import { ai_provider_definitions } from '../acp/runtime/providers.mjs'
const selection = () => z.object({ model: z.string(), reasoningEffort: z.string() }).volatile()
export const Config = z.object(Object.fromEntries(ai_provider_definitions.map(provider => [provider.id, selection()])))
export const inject = ['settings']
export function apply(ctx, config) {
  ctx.effect(() => ctx.settings.configure({ auto: false }))
  ctx.provide('heronAiModelPreferences', {
    get: () => Object.fromEntries(ai_provider_definitions.filter(provider => config[provider.id]).map(provider => [provider.id, config[provider.id].get()])),
    replace: value => ctx.settings.replace('heron-ai-model-preferences', value),
  })
}
