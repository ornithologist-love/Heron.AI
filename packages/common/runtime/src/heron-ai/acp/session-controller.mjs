import { is_model_provider } from './runtime/providers.mjs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { backendId } from './providers.mjs'
import { ai_provider_definitions } from './runtime/providers.mjs'
import { modelBrand, sortModelsByFamily } from './model-family.mjs'


// Workspace-less chats get a private scratch directory, never the host's cwd.
async function scratchDirectory() {
  let stateDir
  try { stateDir = JSON.parse(process.env.HERON_AI_DSH_LAUNCH ?? '{}').stateDir } catch {}
  const now = new Date(), day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const directory = path.join(stateDir || path.join(os.homedir(), '.dsh-heronAi'), 'chats', day, randomUUID().replace(/-/g, '').slice(0, 8))
  return directory
}

export const name = 'heron-ai-session-policy'
export const inject = ['sessionController', 'heronAiAcp', 'heronAiModelPreferences', 'agentDefaultModel', 'agentPresets', 'permissionPresets']
export function apply(ctx) {
  const policy = new HeronAiSessionPolicy(ctx)
  ctx.provide('sessionCommandPolicy', policy)
}

class HeronAiSessionPolicy {
  configurePermission(session, preset) { this.ctx.permissionPresets.set(session, preset) }
  constructor(ctx) {
    this.ctx = ctx
    this.modelPreferences = ctx.heronAiModelPreferences
    this.preferenceWrite = Promise.resolve()
  }
  async create(request, next, selectInitialModel) {
    // An obsolete saved default must not prevent opening a new conversation.
    if (request.sessionId === undefined && request.agentPreset === undefined && this.ctx.agentPresets.defaultId.startsWith('heron-ai-acp-'))
      request = { ...request, agentPreset: 'standard' }
    if (request.workspaceId === undefined && request.cwd === undefined && request.sessionId === undefined)
      request = { ...request, cwd: await scratchDirectory() }
    const result = await next(request)
    const provider = backendId(result.agentPreset ?? request.agentPreset)
    if (request.sessionId === undefined && is_model_provider(provider)) {
      const catalog = await this.ctx.heronAiAcp.registry.loadProviderCatalog(provider)
      const native = this.ctx.agentDefaultModel.currentSelection()
      const saved = this.modelPreferences.get()?.[provider] ?? (native.provider === provider ? native : undefined)
      const model = catalog.models.find(item => item.id === saved?.model)
      const reasoningEffort = model?.heron_ai_effort?.includes(saved?.reasoningEffort) ? saved.reasoningEffort : undefined
      await selectInitialModel({sessionId:result.sessionId,provider,model:model?.id ?? catalog.default_model,
        ...(reasoningEffort ? {reasoningEffort} : {})})
    }
    return result
  }
  async selectModel(request, next) {
    const result = await next(request, false)
    const { provider, ...selection } = result.selected
    const write = this.preferenceWrite.catch(() => {}).then(async () => {
      if (is_model_provider(provider))
        await this.modelPreferences.replace({ ...this.modelPreferences.get(), [provider]: selection })
      await this.ctx.agentDefaultModel.saveSelection(result.selected)
    })
    this.preferenceWrite = write
    await write
    return result
  }
  async prompt(request, signal, next) {
    const configuration = await this.ctx.sessionController.configuration(request.sessionId)
    const provider = backendId(configuration.agentPreset)
    if (!configuration.model && is_model_provider(provider)) {
      const catalog = await this.ctx.heronAiAcp.registry.loadProviderCatalog(provider)
      const saved = this.modelPreferences.get()?.[provider]
      const model = catalog.models.find(item => item.id === saved?.model)
      const reasoningEffort = model?.heron_ai_effort?.includes(saved?.reasoningEffort) ? saved.reasoningEffort : undefined
      await this.ctx.sessionController.selectModel({ sessionId: request.sessionId, provider, model: model?.id ?? catalog.default_model,
        ...(reasoningEffort ? { reasoningEffort } : {}) })
    }
    const found = await this.ctx.sessionController.resolveAgent(request.sessionId)
    if ('error' in found) throw found.error
    const agent = found.agent
    const templates = this.ctx.get('heronAiTemplates')
    const submit = () => templates ? templates.prompt(request, next) : next(request)
    const gateway = this.ctx.heronAiAcp.modelGateway
    if (!gateway) return submit()
    const selected = await this.ctx.sessionController.configuration(request.sessionId)
    return gateway.prompt(request, selected.model?.provider ?? agent.model.current()?.provider, submit)
  }
  async modelCatalog(catalog) {
    const groups = await Promise.all(catalog.groups.filter(group => !group.id.startsWith('heron-ai-acp-')).map(async group => {
      const metadata = is_model_provider(group.id)
        ? await this.ctx.heronAiAcp.registry.catalogModels(group.id).catch(() => []) : []
      // Every provider's picker list follows one family order (see model-family.mjs).
      return { ...group, models: sortModelsByFamily(group.models).map(model => {
        const row = metadata.find(item => item.id === model.id)
        const brand = modelBrand(model.id)
        const displayMetadata = { ...(brand ? { brand } : {}), ...(row?.credits === undefined ? {} : { credits: row.credits }) }
        return { ...model, ...(Object.keys(displayMetadata).length ? { metadata: displayMetadata } : {}),
          ...(row ? { recommended: row.heron_ai_picked === true } : {}) }
      }) }
    }))
    // Configuration entry points remain discoverable before a route is usable.
    // Empty groups advertise no models and never enter routableProviders.
    for (const provider of [{ id: 'deepseek-official', name: 'DeepSeek' }, ...ai_provider_definitions]) {
      if (!groups.some(group => group.id === provider.id)) groups.push({ id: provider.id, name: provider.name, models: [] })
    }
    return { ...catalog, groups }
  }
}
