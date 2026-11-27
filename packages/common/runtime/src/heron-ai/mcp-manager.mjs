import { migrateConfiguration, migratedMcpEntry, nativeEntry } from './migration/config.mjs'
import { syncBundledMcp } from './migration/bundled-mcp.mjs'
import { prepareOAuthClient, openAuthorizationUrl } from './mcp-oauth.mjs'
import { readJson, saveJson } from './migration/files.mjs'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import fs from 'node:fs/promises'
import path from 'node:path'
import { contentSources, readEnabledProductPackages, readMcpConfiguration, registerContentSource } from './product-profile.mjs'
import { readConnectorManifest } from './connector-manifest.mjs'
import { registerMcpToolDiscovery } from './mcp-tool-discovery.mjs'
import { createAgentPluginRegistry } from './agent-plugins/registry.mjs'
import { compileAgentConnections, mergeAgentConnection } from './agent-plugins/connections.mjs'

export const inject = ['connection', 'heronAiAcp', 'appReady', 'tools', 'skills']
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
  registerMcpToolDiscovery(ctx)
  await migrateConfiguration(ctx.heronAiAcp.options)
  const options = ctx.heronAiAcp.options
  const selected = options.bundledMcpServers
  const ownershipFile = path.join(options.home, 'migration', 'content-mcp-sources.json')
  const ownership = await readJson(ownershipFile) ?? { version: 1, servers: {} }
  if (ownership.version !== 1 || !ownership.servers || typeof ownership.servers !== 'object' || Array.isArray(ownership.servers)) throw Error('Invalid MCP content ownership journal')
  const listeners = new Set()
  const connectors = new Map()
  const declarativeConnectors = new Map()
  const connectorSources = new Map()
  let connectorPresentations = new Map()
  let agentDefinitions = new Map(), agentPresentations = new Map(), agentReferences = new Map()
  let pendingDeclarative = new Map()
  const target = path.join(options.home, 'mcp-servers.json')
  let bundled, activeNames
  const sameArray = (a, b) => (a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((item, index) => item === b[index])
  const matchesConnector = (entry, definition) => Boolean(definition && entry.managedConnector === definition.displayName
    && entry.transport === definition.transport && entry.authType === definition.authType
    && (definition.transport === 'stdio' ? entry.command === definition.command : entry.url === definition.url))
  const sameStdioSettings = (entry, definition) => sameArray(entry.args, definition.args) && (entry.cwd ?? undefined) === (definition.cwd ?? undefined)
  const sameManagedSettings = (entry, definition) => matchesConnector(entry, definition)
    && (definition.transport !== 'stdio' || sameStdioSettings(entry, definition))
    && sameArray(entry.oauth?.scopes, definition.oauth?.scopes)
  const managedDefinition = serverName => connectors.get(serverName) ?? declarativeConnectors.get(serverName)
  function refreshConnectorPackages() {
    const presentations = new Map()
    const definitions = new Map()
    const cardIds = new Set()
    const active = new Set()
    for (const [id, { root, manifest }] of readEnabledProductPackages(options)) {
      if (manifest.heronAi?.connectors === undefined) continue
      try {
        const declared = readConnectorManifest(root, manifest.heronAi.connectors)
        for (const cardId of declared.ids) if (cardIds.has(cardId)) throw Error(`Duplicate connector id: ${cardId}`)
        for (const name of declared.presentations.keys()) if (presentations.has(name)) throw Error(`Duplicate connector server: ${name}`)
        const files = manifest.heronAi.content
        const signature = JSON.stringify({ root, files })
        const current = connectorSources.get(id)
        if (current?.signature !== signature && files) {
          current?.dispose()
          connectorSources.set(id, { signature, dispose: registerContentSource({ id, root, files }) })
        }
        if (files) active.add(id)
        for (const cardId of declared.ids) cardIds.add(cardId)
        for (const [name, presentation] of declared.presentations) presentations.set(name, presentation)
        for (const [name, definition] of declared.definitions) definitions.set(name, definition)
      } catch (error) {
        ctx.logger.warn('Unable to load connectors from %s: %s', id, error.message)
      }
    }
    for (const [id, source] of connectorSources) {
      if (active.has(id)) continue
      source.dispose()
      connectorSources.delete(id)
    }
    connectorPresentations = presentations
    pendingDeclarative = definitions
  }
  async function syncDeclarativeConnectors() {
    const desired = pendingDeclarative
    const activeSet = new Set(desired.keys())
    for (const serverName of [...declarativeConnectors.keys()]) {
      if (!activeSet.has(serverName)) declarativeConnectors.delete(serverName)
    }
    if (!desired.size) return
    await withFileLock(target, async () => {
      const state = await readJson(target)
      if (!Array.isArray(state?.servers)) throw Error('Invalid MCP Manager configuration')
      let changed = false
      for (const [serverName, { entry, previousUrl, legacyDisplayName }] of desired) {
        const { displayName, ...settings } = entry
        const existing = state.servers.find(server => server.serverName === serverName)
        const upgrade = existing && previousUrl && matchesConnector(existing, { ...entry, url: previousUrl })
        // Earlier implicit declarations stored the card title as the managed name.
        const legacyName = existing && legacyDisplayName !== undefined && legacyDisplayName !== displayName
          && matchesConnector(existing, { ...entry, displayName: legacyDisplayName })
          && (entry.transport !== 'stdio' || sameStdioSettings(existing, entry))
        if (connectors.has(serverName) || (existing && !matchesConnector(existing, entry) && !upgrade && !legacyName)) {
          ctx.logger.warn('Skipping declarative connector %s: MCP server name is already in use', serverName)
          continue
        }
        if (!existing || upgrade) {
          const next = { ...settings, serverName, managedConnector: displayName, enabled: existing?.enabled ?? settings.enabled }
          if (existing) state.servers[state.servers.indexOf(existing)] = next
          else state.servers.push(next)
          changed = true
        } else if (legacyName || !sameManagedSettings(existing, entry)) {
          if (legacyName) existing.managedConnector = displayName
          if (entry.transport === 'stdio') {
            if (entry.args) existing.args = [...entry.args]
            else delete existing.args
            if (entry.cwd) existing.cwd = entry.cwd
            else delete existing.cwd
          }
          if (entry.oauth?.scopes) existing.oauth = { ...existing.oauth, scopes: [...entry.oauth.scopes] }
          else if (existing.oauth?.scopes) delete existing.oauth.scopes
          changed = true
        }
        declarativeConnectors.set(serverName, entry)
      }
      if (changed) await saveJson(target, state)
    }, { waitMs: 30000 })
  }
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
    await syncDeclarativeConnectors()
    await syncBundledMcp(options, bundled, selected)
  }
  refreshConnectorPackages()
  await refreshSources()
  const notify = () => { for (const listener of listeners) listener() }
  const agentPlugins = await createAgentPluginRegistry(ctx, options, async plugins => {
    const { definitions, presentations, references } = compileAgentConnections(plugins)
    await withFileLock(target, async () => {
      const state = await readJson(target)
      let changed = false
      for (const [id, definition] of definitions) {
        const index = state.servers.findIndex(entry => entry.serverName === id)
        const existing = state.servers[index]
        const next = mergeAgentConnection(existing, definition)
        if (!next) {
          ctx.logger.warn('Agent Plugin server name is already in use: %s', id)
          definitions.delete(id)
          presentations.delete(id)
          continue
        }
        if (JSON.stringify(next) === JSON.stringify(existing)) continue
        if (index < 0) state.servers.push(next)
        else state.servers[index] = next
        changed = true
      }
      if (changed) await saveJson(target, state)
    }, { waitMs: 30_000 })
    agentDefinitions = definitions
    agentPresentations = presentations
    agentReferences = references
    notify()
  })
  ctx.on('plugin-manager/changed', () => {
    refreshConnectorPackages()
    void refreshSources().then(notify).catch(error => ctx.logger.warn('Connector refresh failed: %s', error.message))
  })
  ctx.effect(() => () => { for (const source of connectorSources.values()) source.dispose() })
  const reserved = new Set(ctx.heronAiAcp.options.reservedMcpEndpoints.map(listenerAddress).filter(Boolean))
  ctx.provide('mcpManagerIntegration', {
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    agentPlugins: {
      ...agentPlugins,
      canManage(request) {
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket?.remoteAddress)
          || request.headers['x-dsh-model-remote'] !== undefined) return false
        const admission = ctx.connection.admit(request)
        return admission.peer === ctx.connection.browserPeer && admission.peer?.principal.kind === 'owner'
      },
    },
    async registerConnector({ entry, previousUrl }) {
      const { serverName, displayName, ...settings } = entry
      await withFileLock(target, async () => {
        const state = await readJson(target)
        if (!Array.isArray(state?.servers)) throw Error('Invalid MCP Manager configuration')
        const existing = state.servers.find(server => server.serverName === serverName)
        const upgrade = existing && previousUrl && matchesConnector(existing, { ...entry, url: previousUrl })
        if (connectors.has(serverName) || (existing && !matchesConnector(existing, entry) && !upgrade))
          throw Error(`MCP server name is already in use: ${serverName}`)
        if (!existing || upgrade) {
          // A different OAuth resource requires new consent. Keep the user's enable setting.
          const next = { ...settings, serverName, managedConnector: displayName, enabled: existing?.enabled ?? settings.enabled }
          if (existing) state.servers[state.servers.indexOf(existing)] = next
          else state.servers.push(next)
          await saveJson(target, state)
        }
        connectors.set(serverName, entry)
      }, { waitMs: 30000 })
      notify()
      return () => { connectors.delete(serverName); notify() }
    },
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
    connectorPresentation(entry) {
      if (agentPresentations.has(entry.serverName)) return agentPresentations.get(entry.serverName)
      if (!entry.managedConnector || matchesConnector(entry, managedDefinition(entry.serverName))) {
        return connectorPresentations.get(entry.serverName)
      }
    },
    isAvailable: entry => (entry.agentPlugin
      ? agentDefinitions.get(entry.serverName)?.entry.agentPlugin === entry.agentPlugin
      : (!entry.managedConnector || matchesConnector(entry, managedDefinition(entry.serverName)))
        && (!ownership.servers[entry.serverName] || activeNames.has(entry.serverName)))
      && agentReferences.get(entry.serverName) !== false
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
