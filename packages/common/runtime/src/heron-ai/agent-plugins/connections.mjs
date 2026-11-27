import { agentServerName } from './registry.mjs'

export function compileAgentConnections(plugins) {
  const definitions = new Map()
  const presentations = new Map()
  const references = new Map()
  for (const plugin of plugins) {
    const rows = new Map()
    for (const server of plugin.servers) {
      const existingId = plugin.bundled ? server.existingId : undefined
      if (!server.entry && !existingId) continue
      const id = existingId ?? agentServerName(plugin.name, server.key)
      rows.set(server.key, { ...server, id })
      if (existingId && !server.entry) references.set(id, plugin.enabled)
      if (!plugin.enabled || !server.entry) continue
      const owner = `${plugin.name}:${server.key}`
      definitions.set(id, {
        entry: { ...server.entry, serverName: id, agentPlugin: owner, managedConnector: owner },
        legacyName: existingId ? server.displayName : undefined,
        legacyId: existingId,
        previousUrl: existingId ? server.previousUrl : undefined,
      })
    }
    if (!plugin.enabled) continue
    const cards = plugin.cards.length ? plugin.cards : [{
      id: plugin.name, title: plugin.title, description: plugin.description, icon: plugin.icon, servers: [...rows.keys()],
    }]
    for (const { servers, ...brand } of cards) {
      for (const key of servers) {
        const row = rows.get(key)
        if (!row) continue
        presentations.set(row.id, servers.length === 1 ? brand : {
          title: row.title ?? row.key, description: row.description ?? { zh: '', en: '' }, group: brand,
        })
      }
    }
  }
  return { definitions, presentations, references }
}

function sameResource(existing, next) {
  return existing.transport === next.transport && (existing.authType ?? 'none') === (next.authType ?? 'none')
    && (next.transport === 'stdio' ? existing.command === next.command : existing.url === next.url)
}

/** Reuse authorization only when the resource identity remains the same. */
export function mergeAgentConnection(existing, { entry, legacyName, legacyId, previousUrl }) {
  if (!existing) return entry
  const same = sameResource(existing, entry)
  const own = existing.agentPlugin === entry.agentPlugin
  const legacy = Boolean(legacyId && !existing.agentPlugin && (existing.managedConnector ?? undefined) === legacyName
    && (same || (previousUrl && sameResource(existing, { ...entry, url: previousUrl }))))
  if (!own && !legacy) return undefined
  const updated = { ...entry, enabled: existing.enabled ?? entry.enabled }
  if (same && entry.authType === 'oauth' && existing.oauth) {
    updated.oauth = { ...existing.oauth, scopes: entry.oauth?.scopes }
  }
  return updated
}
