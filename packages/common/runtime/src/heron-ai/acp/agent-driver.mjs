import { is_model_provider } from './runtime/providers.mjs'
import { backendId } from './providers.mjs'

export const name = 'heron-ai-agent-driver'
export const inject = ['agentLoop', 'agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'heronAiAcp', 'attachments', 'approval', 'sessionPersistence', 'sandboxPolicy', 'fs', 'sessionProjections']

export function apply(ctx) {
  const presetOf = session => session.snapshotEvents().findLast(event => event.type === 'agent-preset/selected')?.data.agentPreset ?? session.header.agentPreset
  const facts = {
    providerOf: agent => backendId(presetOf(agent.session)),
    started: session => (ctx.sessionProjections.stateOf(session, 'turnBoundary')?.lastTurn ?? 0) > 0,
    selection: (agent, fallback) => ctx.sessionProjections.stateOf(agent.session, 'modelSelection')?.pending ?? agent.session.requestHeader()?.config ?? fallback,
  }
  ctx.provide('heronAiAgents', facts)
  ctx.on('agent/created', async ({ agent, source, signal }) => {
    const provider = facts.providerOf(agent)
    if (!is_model_provider(provider)) return
    const selection = facts.selection(agent)
    if (source === 'startup' || selection?.provider === 'heron-ai-acp-' + provider) {
      const catalog = await ctx.heronAiAcp.registry.loadProviderCatalog(provider)
      signal?.throwIfAborted()
      const model = source === 'startup' ? catalog.default_model : selection.model.replace(provider + '/', '')
      if (catalog.models.some(item => item.id === model)) agent.session.append('model/selection', { provider, model })
    }
  })
}
