import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { validateCatalog } from './catalog-schema.mjs'
import { readContent, productProfile } from '../../product-profile.mjs'

// The optional deployment catalog may be contributed by an enabled package.
export let bundledDirectory = normalizeDirectory(readContent('provider-catalog.json'))
if (!bundledDirectory) throw Error('Bundled Provider catalog is missing or invalid: heron-ai/content/provider-catalog.json')
const instances = new Map()
const LIMIT = 1024 * 1024
const CACHE_VERSION = 2
export function refreshBundledDirectory() {
  const value = normalizeDirectory(readContent('provider-catalog.json'))
  if (!value) throw Error('Contributed Provider catalog is invalid')
  bundledDirectory = value
}

export function providerCatalogUrl(serverUrl) {
  if (!serverUrl) return undefined
  const url = new URL('/api/ai/providers', serverUrl)
  url.port = '8792'; url.username = url.password = ''
  return url.href
}

export function normalizeDirectory(value) {
  if (!value || value.schema_version !== 1 || !value.providers || Array.isArray(value.providers)) return null
  // Retired channels (deployment content) are dropped even while a server catalog still lists them.
  const retired = new Set(productProfile.retiredProviders ?? [])
  const entries = Object.entries(value.providers).filter(([id]) => !retired.has(id))
  if (entries.length > 64) return null
  if (!entries.length) return value.default_provider || value.public_default_provider ? null : { schema_version: 1, providers: {} }
  const providers = {}
  for (const [id, row] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id) || !row || row.transport !== 'llm'
      || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 100
      || row.public !== undefined && typeof row.public !== 'boolean' || row.capabilities?.skills !== 'dsh' || row.capabilities?.mcp !== 'dsh'
      || row.capabilities?.sessions !== 'native') return null
    const catalog = validateCatalog(row)
    if (!catalog || !row.public && (!catalog.base_url || !catalog.api)) return null
    let credential
    if (row.credential) {
      const c = row.credential
      if (row.public || c.field !== 'api_key' || typeof c.label !== 'string' || !c.label || c.label.length > 100) return null
      credential = { field: 'api_key', label: c.label }
      for (const field of ['placeholder', 'help_url', 'help_label']) {
        if (c[field] === undefined) continue
        if (typeof c[field] !== 'string' || c[field].length > 300) return null
        if (field === 'help_url') {
          try { const u = new URL(c[field]); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return null } catch { return null }
        }
        credential[field] = c[field]
      }
    }
    if (row.integration !== undefined && (typeof row.integration !== 'string' || !/^[a-zA-Z0-9@/_.-]{1,128}$/.test(row.integration))) return null
    providers[id] = { name: row.name, transport: 'llm', ...(row.public ? { public: true } : {}),
      ...(row.integration ? { integration: row.integration } : {}),
      capabilities: { skills: 'dsh', mcp: 'dsh', sessions: 'native' }, ...(credential ? { credential } : {}), ...catalog }
  }
  if (!providers[value.default_provider] || value.public_default_provider && !providers[value.public_default_provider]?.public) return null
  return { schema_version: 1, default_provider: value.default_provider, public_default_provider: value.public_default_provider, providers }
}

export function providerDirectory({ stateDirectory, catalogUrl }) {
  // Normalized caches cannot recover metadata discarded by an earlier decoder.
  // A changed decoder or contribution policy must fetch a full body, never reuse its ETag.
  const policy = createHash('sha256').update(JSON.stringify([CACHE_VERSION,
    Object.entries(productProfile.modelFieldAliases ?? {}).sort(), [...productProfile.retiredProviders ?? []].sort()])).digest('hex')
  const key = JSON.stringify([path.resolve(stateDirectory), catalogUrl, policy])
  if (!instances.has(key)) instances.set(key, new ProviderDirectory(stateDirectory, catalogUrl, policy))
  return instances.get(key)
}

function localBindings(value) {
  for (const [id, row] of Object.entries(value.providers))
    if (bundledDirectory.providers[id]?.integration) row.integration = bundledDirectory.providers[id].integration
  return value
}

class ProviderDirectory {
  constructor(stateDirectory, url, policy) {
    this.file = path.join(stateDirectory, 'catalog', 'provider-directory.json')
    this.url = url; this.policy = policy; this.listeners = new Set(); this.source = 'bundled'; this.value = bundledDirectory; this.retryAt = 0
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      const cached = normalizeDirectory(saved.directory)
      if (cached && saved.url === this.url && saved.policy === this.policy) {
        this.value = localBindings(cached); this.source = 'cache'; this.etag = saved.etag
      }
    } catch {}
  }
  status() {
    return { source: this.source, stale: !!this.error, revision: createHash('sha256').update(JSON.stringify(this.value)).digest('hex'),
      ...(this.error ? { error: this.error } : {}) }
  }
  observe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  load(force = false) {
    if (!this.url) return Promise.resolve(this.value)
    if (this.pending) return this.pending
    if (!force && Date.now() < this.retryAt) return Promise.resolve(this.value)
    this.retryAt = Date.now() + 60_000
    this.pending = this.fetch().then(async result => {
      const previous = JSON.stringify(this.value)
      this.value = result; this.source = 'server'; this.error = undefined
      await writeFileAtomic(this.file, JSON.stringify({ url: this.url, policy: this.policy, directory: result, etag: this.etag }), { mode: 0o600, dirMode: 0o700 }).catch(() => {})
      if (JSON.stringify(result) !== previous) for (const listener of this.listeners) listener(result)
      return result
    }).catch(error => {
      this.retryAt = Date.now() + 15_000
      this.error = /HTTP \d+/.exec(error.message)?.[0] ?? 'Provider 目录暂不可用'
      return this.value
    }).finally(() => { this.pending = undefined })
    return this.pending
  }
  async fetch() {
    const url = new URL(this.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Provider 目录地址无效')
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: this.etag && this.source !== 'bundled' ? { 'If-None-Match': this.etag } : {} })
    if (response.status === 304 && this.etag) return this.value
    if (!response.ok) { await response.body?.cancel(); throw Error(`Provider 目录 HTTP ${response.status}`) }
    const chunks = []; let size = 0
    for await (const chunk of response.body) {
      size += chunk.byteLength
      if (size > LIMIT) throw Error('Provider 目录响应过大')
      chunks.push(chunk)
    }
    const result = normalizeDirectory(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    if (!result) throw Error('Provider 目录格式无效')
    const etag = response.headers.get('etag')
    this.etag = etag && etag.length <= 256 ? etag : undefined
    return localBindings(result)
  }
}
