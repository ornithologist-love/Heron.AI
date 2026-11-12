// Provider catalog and credentials. Every model channel runs through DSH.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { provider_definition, ai_provider_definitions, configureProviderDirectory } from './providers.mjs'
import { validateCatalog } from './catalog-schema.mjs'
import { providerDirectory } from './provider-directory.mjs'

const RUNTIME_FILE_LIMIT_BYTES = 256 * 1024

export class ProviderRegistry {
  constructor({ stateDirectory, hostRoot, catalogUrl, legacyConfigRoot, onStatusChanged }) {
    this.stateDirectory = stateDirectory
    this.hostRoot = hostRoot
    this.legacyConfigRoot = legacyConfigRoot
    this.onStatusChanged = onStatusChanged ?? (() => {})
    this.statuses = new Map() // id -> { id, name, state, detail, revision }
    this.directory = providerDirectory({ stateDirectory, catalogUrl })
    this.releaseDirectory = this.directory.observe(value => {
      configureProviderDirectory(value)
      for (const id of Object.keys(value.providers)) {
        void this.refreshStatus(id)
        this.onCatalogChanged?.(id)
      }
    })
  }

  statusList() {
    return ai_provider_definitions.map(definition => this.statuses.get(definition.id) ?? {
      id: definition.id, name: definition.name, state: 'Detecting', detail: '', revision: '',
      credential_configured: this.credentialConfigured(definition),
    })
  }

  definition(providerId) {
    return provider_definition(providerId)
  }

  async refresh() {
    await Promise.all(ai_provider_definitions.map(definition => this.probe(definition.id)))
    this.notifyStatusChanged()
  }

  notifyStatusChanged() {
    const statuses = this.statusList()
    const snapshot = JSON.stringify(statuses)
    if (snapshot === this.lastStatusSnapshot) return
    this.lastStatusSnapshot = snapshot
    this.onStatusChanged(statuses)
  }

  async probe(providerId) {
    const definition = this.definition(providerId)
    if (!definition) return
    try {
      if (definition.llm) {
        this.statuses.set(providerId, await this.probeModel(definition))
      } else {
        this.statuses.set(providerId, unavailable(definition, `未配置 ${definition.name} 模型渠道`))
      }
    } catch (error) {
      // A failed probe (for example an unreachable catalog) must not flip the
      // credential flag: the dialog decides masking from what is stored.
      this.statuses.set(providerId, { ...unavailable(definition, error.message), credential_configured: this.credentialConfigured(definition) })
    }
  }

  async probeModel(definition) {
    const catalog = await this.loadProviderCatalog(definition.id)
    return { id: definition.id, name: definition.name, state: 'Ready',
      detail: definition.public ? '额度由所配置的共享通道管理' : 'DSH 模型渠道', revision: JSON.stringify(catalog), credential_configured: this.credentialConfigured(definition) }
  }

  // All providers use the same validated directory and its last-good cache.
  async loadProviderCatalog(providerId) {
    const definition = this.definition(providerId)
    if (!definition?.llm) throw new Error(`未知 Provider：${providerId}`)
    const directory = await this.directory.load()
    configureProviderDirectory(directory)
    const catalog = validateCatalog(directory.providers[providerId])
    if (!catalog) throw Error('Provider 模型目录不存在')
    return catalog
  }

  // Recompute one provider's status (runtime-file revision included) after its
  // catalog changed. Failures keep the previous status; the next probe retries.
  async refreshStatus(providerId) {
    try {
      this.statuses.set(providerId, await this.probeModel(this.definition(providerId)))
      this.notifyStatusChanged()
    } catch { /* keep the previous status */ }
  }

  // Model list for picker decoration (credits badges). Providers without a Pi
  // catalog simply report no models instead of failing the UI.
  async catalogModels(providerId) {
    if (!this.definition(providerId)?.llm) return []
    const catalog = await this.loadProviderCatalog(providerId)
    return catalog.models
  }

  // A page reload keeps the sidecar alive. Explicitly fetch the Server catalog
  // before the new ACP connection so F5 can pick up config-only model changes.
  async refreshCatalog(providerId) {
    const definition = this.definition(providerId)
    if (!definition?.llm) throw new Error(`未知 Pi Provider：${providerId}`)
    const previousRevision = this.statuses.get(providerId)?.revision ?? ''
    configureProviderDirectory(await this.directory.load(true))
    const status = await this.probeModel(this.definition(providerId))
    this.statuses.set(providerId, status)
    this.notifyStatusChanged()
    this.onCatalogChanged?.(providerId)
    return { models: (await this.loadProviderCatalog(providerId)).models, revision: status.revision, changed: status.revision !== previousRevision }
  }

  endpoint(definition, catalog) { return resolveEndpoint(definition, catalog) }

  settingsPath(name, { legacy = false } = {}) {
    if (name !== path.basename(name) || !name.toLowerCase().endsWith('.json'))
      throw new Error('Provider settings 只能使用 JSON 文件名')
    return legacy
      ? path.join(this.legacyConfigRoot, name)
      : path.join(this.stateDirectory, 'providers', name)
  }

  resolveSettingsFile(name) {
    const local = this.settingsPath(name)
    if (!this.legacyConfigRoot) return local
    const legacy = this.settingsPath(name, { legacy: true })
    return fs.existsSync(local) || !fs.existsSync(legacy) ? local : legacy
  }

  // Whether the provider already holds a usable local credential, decided by
  // the same fields providerEnvironment requires. Only this boolean reaches the
  // status events and the WebView; credential values never leave the process.
  credentialConfigured(definition) {
    if (!definition.llm?.settings_file || !definition.llm.environment_from_settings) return false
    const fields = Object.values(definition.llm.environment_from_settings)
    if (!fields.length) return false
    try {
      const file = this.resolveSettingsFile(definition.llm.settings_file)
      if (!fs.existsSync(file)) return false
      const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
      return fields.every(field => typeof settings?.[field] === 'string' && !!settings[field].trim())
    } catch {
      return false
    }
  }

  async updateSettings(providerId, values) {
    const definition = this.definition(providerId)
    if (!definition) throw new Error('Provider 不存在')
    const entries = Object.entries(values ?? {})
    if (!definition.llm?.settings_file) throw new Error('Provider 不支持本地配置')
    if (!entries.length || entries.length > 32) throw new Error('provider 与 values 均为必填')
    for (const [name, value] of entries) {
      if (!/^[A-Za-z0-9_]{1,80}$/.test(name)) throw new Error('Provider 配置字段名无效')
      if (typeof value !== 'string' || value.length > 16 * 1024) throw new Error('Provider 配置值必须是字符串')
    }
    const source = this.resolveSettingsFile(definition.llm.settings_file)
    let settings = {}
    if (fs.existsSync(source)) {
      try {
        settings = JSON.parse(await fs.promises.readFile(source, 'utf8'))
        if (!settings || typeof settings !== 'object' || Array.isArray(settings))
          throw new Error('not an object')
      } catch {
        throw new Error('现有 Provider 配置不是有效 JSON')
      }
    }
    Object.assign(settings, Object.fromEntries(entries))
    await writeFileAtomic(this.settingsPath(definition.llm.settings_file), JSON.stringify(settings, null, 2), { mode: 0o600, dirMode: 0o700 })
    // Saving credentials is the user's "I just configured this provider" signal:
    // re-read the Server catalog so a config-only channel change (endpoint, model
    // list, api) takes effect without restarting the Client. The revalidation
    // must not depend on the Pi runtime being deployed yet, and a failure only
    // keeps the previous status detail.
    await this.directory.load(true)
    await this.refresh()
  }

  // Build the child environment from opaque local provider settings. Values
  // never cross back into the WebView or command line.
  providerEnvironment(definition) {
    const environment = {}
    if (!definition.llm?.environment_from_settings) return environment
    let settings = null
    const settingsPath = this.resolveSettingsFile(definition.llm.settings_file)
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      } catch {
        throw new Error(`${definition.name} 本地配置无效`)
      }
    }
    for (const [environmentName, field] of Object.entries(definition.llm.environment_from_settings)) {
      if (!/^[A-Za-z0-9_]+$/.test(environmentName)) throw new Error('ACP Runtime 环境变量名无效')
      const value = settings?.[field]
      if (typeof value !== 'string' || !value.trim()) throw new Error(`${definition.name} 缺少本地凭据`)
      environment[environmentName] = value
    }
    return environment
  }
}

// Shared by the server fetch and the disk cache: a usable catalog must carry at
// least one well-formed model whose id matches the declared default. Models are
// normalized to id/name plus optional runtime fields, so unrelated server
// fields never reach the runtime files or the picker. Endpoint fields stay
// optional so a catalog written before endpoint config existed still resolves
// through the definition fallback.
// The Server value always wins; the definition fallback only serves catalogs
// written before the endpoint moved into config.
function resolveEndpoint(definition, catalog) {
  const baseUrl = catalog.base_url ?? definition.llm.default_base_url
  const api = catalog.api ?? definition.llm.default_api
  if (!baseUrl || !api)
    throw new Error(`${definition.name} 模型目录未配置 base_url/api`)
  return { baseUrl, api }
}

// Pi entry files live in piRoot; packages resolve like Node does from there,
// so node_modules may sit in piRoot itself or in the package root one level up.
function unavailable(definition, detail) {
  return { id: definition.id, name: definition.name, state: 'Unavailable', detail, revision: '' }
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex')
}
