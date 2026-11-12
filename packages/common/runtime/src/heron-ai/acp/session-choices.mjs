import { is_model_provider } from './runtime/providers.mjs'
// Composer choices of a native DSH session: model and reasoning effort.
import { backendId } from './providers.mjs'

export const name = 'heron-ai-session-choices'
export const inject = ['sessionController', 'heronAiAcp', 'agents', 'heronAiModelPreferences', 'agentDefaultModel']

export function apply(ctx) {
  const writes = new Map()
  const serial = (id, operation) => {
    const task = (writes.get(id) ?? Promise.resolve()).catch(() => {}).then(operation)
    writes.set(id, task)
    void task.finally(() => { if (writes.get(id) === task) writes.delete(id) }).catch(() => {})
    return task
  }
  const service = {
    async state(id) {
      const configuration = await ctx.sessionController.configuration(id)
      const provider = backendId(configuration.agentPreset)
      const live = ctx.agents.get(id)
      const template = await ctx.get('heronAiTemplates')?.stateOf(id)
      if (!is_model_provider(provider)) return { external: false, provider, started: !configuration.blank }
      const catalog = await ctx.heronAiAcp.registry.loadProviderCatalog(provider)
      // A channel-unservable model is neither offered nor resumable.
      const offered = catalog.models.filter(item => item.heron_ai_agent_unsupported !== true)
      const remembered = ctx.heronAiModelPreferences.get()?.[provider]
      const selected = configuration.model ?? (remembered?.model ? { provider, ...remembered } : { provider, model: catalog.default_model })
      const current = offered.find(item => item.id === selected.model)
      const model = current?.id ?? catalog.default_model
      const controls = [{ id: 'model', name: '模型', currentValue: model,
        options: offered.map(item => ({ value: item.id, name: item.name })) }]
      if (current?.heron_ai_effort?.length) controls.push({ id: 'thought_level', name: '思考强度', currentValue: selected.reasoningEffort ?? 'off',
        options: ['off', ...current.heron_ai_effort].map(value => ({ value, name: value })) })
      return { external: false, provider, configOptions: controls, modelMetadata: catalog.models, model,
        capabilities: { skills: 'dsh', mcp: 'dsh' }, busy: live?.status === 'running', started: !configuration.blank, template }
    },
    select(id, choice) {
      return serial(id, async () => {
        const configuration = await ctx.sessionController.configuration(id)
        const provider = backendId(configuration.agentPreset)
        if (ctx.agents.get(id)?.status === 'running') throw Error('请等待当前任务结束后再修改配置')
        if (choice.action === 'refresh') {
          await ctx.heronAiAcp.registry.refreshCatalog(provider)
          if (is_model_provider(provider)) await ctx.heronAiAcp.syncModels(provider)
          return
        }
        if (!is_model_provider(provider) || !['model', 'thought_level'].includes(choice.id)) throw Error('Unsupported provider configuration')
        const catalog = await ctx.heronAiAcp.registry.loadProviderCatalog(provider)
        const current = configuration.model ?? { provider, model: catalog.default_model }
        const model = choice.id === 'model' ? choice.value.replace(provider + '/', '') : current.model
        const item = catalog.models.find(row => row.id === model)
        if (!item) throw Error('Unknown provider model')
        if (item.heron_ai_agent_unsupported === true) throw Error('该模型当前不可用于 Agent 会话')
        const effort = choice.id === 'thought_level' ? choice.value : undefined
        if (effort && effort !== 'off' && !item.heron_ai_effort?.includes(effort)) throw Error('Unsupported reasoning effort')
        await ctx.sessionController.selectModel({ sessionId: id, provider, model,
          ...(effort && effort !== 'off' ? { reasoningEffort: effort } : {}) })
      })
    },
  }
  ctx.provide('heronAiSessionChoices', service)
  ctx.effect(() => async () => { await Promise.allSettled([...writes.values()]) }, 'heron-ai: composer configuration writes')
}
