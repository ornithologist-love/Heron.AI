import { migrateConfiguration, migratedMcpEntry, nativeEntry } from './migration/config.mjs'
import { syncBundledMcp } from './migration/bundled-mcp.mjs'
import { prepareOAuthClient, openAuthorizationUrl } from './mcp-oauth.mjs'
import { readJson, saveJson } from './migration/files.mjs'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import fs from 'node:fs/promises'
import path from 'node:path'
import { contentSources, readMcpConfiguration, registerContentSource } from './product-profile.mjs'

export const inject = ['connection', 'heronAiAcp', 'appReady']
export const name = 'heron-ai-mcp-integration'

// A host may serve an endpoint only through its own admitted tools (H2.1
// --reserved-mcp-endpoint). Its listener is reserved, including localhost aliases
// and alternate paths, before any connection or OAuth.
const listenerAddress = value => {
  try {
    const url = new URL(value)
    return `${url.protocol}//${['localhost', '[::1]'].includes(url.hostname) ? '127.0.0.1' : url.hostname}:${url.port}`
  } catch { return undefined }
}

export async function apply(ctx) {
  await migrateConfiguration(ctx.heronAiAcp.options)
  const options = ctx.heronAiAcp.options
  const selected = options.bundledMcpServers
  const ownershipFile = path.join(options.home, 'migration', 'content-mcp-sources.json')
  const ownership = await readJson(ownershipFile) ?? { version: 1, servers: {} }
  if (ownership.version !== 1 || !ownership.servers || typeof ownership.servers !== 'object' || Array.isArray(ownership.servers)) throw Error('Invalid MCP content ownership journal')
  const listeners = new Set()
  let bundled, activeNames
  async function refreshSources() {
    bundled = readMcpConfiguration(options)
    activeNames = new Set(Object.keys(bundled.mcpServers ?? {}))
    for (const [id, files] of contentSources) {
      if (!files['mcp-config.json']) continue
      const source = JSON.parse(await fs.readFile(files['mcp-config.json'], 'utf8'))
      for (const name of Object.keys(source.mcpServers ?? {})) ownership.servers[name] = id
    }
    await saveJson(ownershipFile, ownership)
    // A selected name may belong to a temporarily disabled optional package.
    const wanted = (selected ?? [...activeNames]).filter(name => activeNames.has(name))
    // Host bundles may have already seeded their own servers. Add missing
    // selected defaults without overwriting user endpoints, credentials or disables;
    // a host may seed them disabled so users opt in from the MCP settings.
    const enabled = options.bundledMcpServersEnabled !== false
    const target = path.join(options.home, 'mcp-servers.json')
    await withFileLock(target, async () => {
      const state = await readJson(target)
      if (!Array.isArray(state?.servers)) throw new Error('Invalid MCP Manager configuration')
      const missing = wanted.filter(name => !state.servers.some(entry => entry.serverName === name))
      if (!missing.length) return
      state.servers.push(...missing.map(name => {
        const entry = nativeEntry(name, bundled.mcpServers[name])
        return { ...entry, enabled: entry.enabled && enabled }
      }))
      await saveJson(target, state)
    }, { waitMs: 30000 })
    await syncBundledMcp(options, bundled, selected)
  }
  await refreshSources()
  const notify = () => { for (const listener of listeners) listener() }
  const reserved = new Set(ctx.heronAiAcp.options.reservedMcpEndpoints.map(listenerAddress).filter(Boolean))
  ctx.provide('mcpManagerIntegration', {
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    async registerContentSource(source) {
      const unregister = registerContentSource(source)
      try { await refreshSources() } catch (error) { unregister(); throw error }
      notify()
      return async () => { unregister(); await refreshSources(); notify() }
    },
    // Explicit server selection is independent of business UI, skills and hosts.
    // The existing Manager still owns connections, tools and user settings.
    products: {
      active: selected === undefined ? options.mcpProduct ?? 'default' : 'heron-ai-selected',
      servers: { [options.mcpProduct ?? 'default']: Object.keys(ownership.servers),
        ...(selected === undefined ? {} : { 'heron-ai-selected': selected }) },
    },
    isAvailable: entry => (!ownership.servers[entry.serverName] || activeNames.has(entry.serverName))
      && (selected === undefined || !ownership.servers[entry.serverName] || selected.includes(entry.serverName))
      && (ctx.heronAiAcp.options.automationMcpServers === undefined
      || ctx.heronAiAcp.options.automationMcpServers.includes(entry.serverName))
      && (!entry.url || !reserved.has(listenerAddress(entry.url))),
    isEnabled: entry => ctx.heronAiAcp.options.automationMcpServers === undefined
      ? entry.enabled !== false : ctx.heronAiAcp.options.automationMcpServers.includes(entry.serverName),
    transformEntry: migratedMcpEntry,
    authorizeRequest: request => !ctx.connection.requestRejection(request),
    prepareOAuthClient,
    openAuthorizationUrl,
    onReady: start => ctx.appReady.onReady(start),
  })
}
