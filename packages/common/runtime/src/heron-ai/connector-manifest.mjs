import fs from 'node:fs'
import path from 'node:path'

function readIcon(root, file) {
  if (file === undefined) return undefined
  if (typeof file !== 'string' || path.isAbsolute(file)) throw Error('Connector icon must be relative to its package')
  const directory = fs.realpathSync(root)
  const asset = fs.realpathSync(path.resolve(directory, file))
  const relative = path.relative(directory, asset)
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw Error('Connector icon must stay inside its package')
  }
  switch (path.extname(asset).toLowerCase()) {
    case '.png': return 'data:image/png;base64,' + fs.readFileSync(asset, 'base64')
    case '.svg': return 'data:image/svg+xml,' + encodeURIComponent(fs.readFileSync(asset, 'utf8'))
    default: throw Error('Connector icon must be PNG or SVG')
  }
}

function descriptionOf(value) {
  if (value === undefined) return { zh: '', en: '' }
  if (typeof value?.zh !== 'string' || typeof value.en !== 'string') throw Error('Connector description requires zh and en strings')
  return value
}

function definitionOf(card, server) {
  if (server.transport === undefined && server.url === undefined && server.command === undefined) return undefined
  if (server.transport !== 'streamable-http' && server.transport !== 'stdio') {
    throw Error(`Connector ${card.id} server ${server.id} has unsupported transport`)
  }
  if (server.transport === 'streamable-http') {
    if (typeof server.url !== 'string' || !/^https?:\/\//.test(server.url)) {
      throw Error(`Connector ${card.id} server ${server.id} requires an http(s) url`)
    }
  } else if (typeof server.command !== 'string' || !server.command.trim()) {
    throw Error(`Connector ${card.id} server ${server.id} requires a command`)
  }
  if (server.authType !== undefined && server.authType !== 'none' && server.authType !== 'oauth') {
    throw Error(`Connector ${card.id} server ${server.id} has invalid authType`)
  }
  if (server.previousUrl !== undefined && (typeof server.previousUrl !== 'string' || !/^https?:\/\//.test(server.previousUrl))) {
    throw Error(`Connector ${card.id} server ${server.id} has invalid previousUrl`)
  }
  if (server.oauth !== undefined) {
    if (!server.oauth || typeof server.oauth !== 'object' || Array.isArray(server.oauth)) {
      throw Error(`Connector ${card.id} server ${server.id} has invalid oauth config`)
    }
    if (server.oauth.scopes !== undefined && (!Array.isArray(server.oauth.scopes) || server.oauth.scopes.some(s => typeof s !== 'string'))) {
      throw Error(`Connector ${card.id} server ${server.id} oauth.scopes must be string[]`)
    }
  }
  const displayName = typeof server.displayName === 'string' ? server.displayName.trim() : ''
  const entry = {
    serverName: server.id,
    displayName: displayName || server.id,
    transport: server.transport,
    ...(server.transport === 'streamable-http' ? { url: server.url } : {
      command: server.command,
      ...(Array.isArray(server.args) ? { args: [...server.args] } : {}),
      ...(server.cwd ? { cwd: server.cwd } : {}),
    }),
    enabled: server.enabled === true,
    ...(server.authType ? { authType: server.authType } : {}),
    ...(server.oauth ? { oauth: { ...(server.oauth.scopes ? { scopes: [...server.oauth.scopes] } : {}) } } : {}),
  }
  return { entry, previousUrl: server.previousUrl, legacyDisplayName: displayName ? undefined : card.title }
}

export function readConnectorManifest(root, cards) {
  if (!Array.isArray(cards)) throw Error('heronAi.connectors must be an array')
  const ids = new Set()
  const presentations = new Map()
  const definitions = new Map()
  for (const card of cards) {
    if (typeof card?.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(card.id)
      || typeof card.title !== 'string' || !card.title.trim() || !Array.isArray(card.servers) || !card.servers.length) {
      throw Error('Connector requires a kebab-case id, title and at least one server')
    }
    if (ids.has(card.id)) throw Error(`Duplicate connector id: ${card.id}`)
    ids.add(card.id)
    const brand = { id: card.id, title: card.title, description: descriptionOf(card.description), icon: readIcon(root, card.icon) }
    for (const server of card.servers) {
      if (typeof server?.id !== 'string' || !server.id || (card.servers.length > 1 && !server.title?.trim())) {
        throw Error(`Connector ${card.id} requires server ids and titles for grouped services`)
      }
      if (presentations.has(server.id)) throw Error(`Duplicate connector server: ${server.id}`)
      presentations.set(server.id, card.servers.length === 1 ? brand : {
        title: server.title, description: descriptionOf(server.description), group: brand,
      })
      const definition = definitionOf(card, server)
      if (definition) definitions.set(server.id, definition)
    }
  }
  return { ids, presentations, definitions }
}
