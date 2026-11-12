// Common base for business presets: the product's standard plugin set with a
// business persona. A business plugin (for example the UE host's contribution)
// supplies the name, description, order and persona and registers the result
// through the native preset registry; there is no second registry.
import { EntryGroup } from '@deepseek-ai/cordis-plugin-loader'

/**
 * @param {*} ctx
 * @param {{ standard: object[], delegatedModels?: object[] }} config the standard preset's plugin rows,
 *   as composed, and the LLM routes a persona may delegate to
 */
export default class PresetBase {
  // Child expressions (including the persona's {{model}}) are evaluated only
  // when the derived native preset activates, just like dsh-agent-preset.
  static [EntryGroup.key] = true

  constructor(ctx, { standard, delegatedModels = [] }) {
    ctx.provide('presetBase', Object.freeze({
    /**
     * A delegated default names its route so the persona can cite it, instead of
     * making every prompt spell out provider and model ids.
     * @param {{ id: string, name: string, description?: string, order?: number,
     *   persona?: string | ((delegatedModel: string) => string),
     *   delegatedModel?: { provider: string, model: string } }} preset
     * @returns {{ id: string, name: string, description: string, order: number, plugins: object[] }}
     */
    derive({ id, name, description = '', order = 20, persona, delegatedModel }) {
      if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) throw new Error('A preset needs an id and a name.')
      if (delegatedModel !== undefined && !delegatedModels.some(route =>
        route.provider === delegatedModel.provider && route.model === delegatedModel.model))
        throw new Error(`Delegated model ${delegatedModel.provider}/${delegatedModel.model} is not available to presets.`)
      const route = delegatedModel === undefined ? '' : `${delegatedModel.provider}/${delegatedModel.model}`
      const plugins = structuredClone(standard).map(plugin => {
        if (plugin.id === 'persona') return { ...plugin, config: { ...plugin.config,
          prefix: persona === undefined ? plugin.config.prefix
            : typeof persona === 'function' ? persona(route) : persona.replaceAll('{{delegatedModel}}', route) } }
        if (delegatedModel !== undefined && plugin.id === 'tool-subagent')
          return { ...plugin, config: { ...plugin.config, agentOptions: { ...delegatedModel } } }
        return plugin
      })
      return { id, name, description, order, plugins }
    },
    }))
  }
}
