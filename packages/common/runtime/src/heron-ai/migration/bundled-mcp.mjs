import path from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { digest, migrationRoot, readJson, saveJson } from './files.mjs'
import { nativeEntry } from './config.mjs'

const authorizationKey = headers => Object.keys(headers ?? {}).find(key => key.toLowerCase() === 'authorization')
const authorization = headers => headers?.[authorizationKey(headers)]
function replaceAuthorization(headers, value) {
  const next = { ...headers }
  for (const key of Object.keys(next)) if (key.toLowerCase() === 'authorization') delete next[key]
  next.Authorization = value
  return next
}

// Upgrade only explicitly managed defaults. A changed endpoint must never
// receive a bundled credential; user credentials and disabled state stay owned
// by the user. The journal keeps a fingerprint, not a second plaintext secret.
export async function syncBundledMcp(options, bundled, selected) {
  const defaults = Object.entries(bundled.mcpServers ?? {}).filter(([name, item]) => item.managed === true
    && (selected === undefined || selected.includes(name)))
  if (!defaults.length) return
  const target = path.join(options.home, 'mcp-servers.json')
  const marker = path.join(migrationRoot(options), 'bundled-mcp.json')
  await withFileLock(target, async () => {
    const current = await readJson(target)
    if (!Array.isArray(current?.servers)) throw Error('Invalid MCP Manager configuration')
    const previous = await readJson(marker) ?? { version: 1, servers: {} }
    if (previous.version !== 1 || !previous.servers || typeof previous.servers !== 'object' || Array.isArray(previous.servers))
      throw Error('Invalid bundled MCP upgrade journal')
    let changed = false
    for (const [name, definition] of defaults) {
      const incoming = nativeEntry(name, definition)
      const nextAuthorization = authorization(incoming.headers)
      if (!incoming.url || !nextAuthorization) throw Error('Bundled MCP is missing its released connection credential: ' + name)
      let existing = current.servers.find(entry => entry.serverName === name)
      if (!existing) {
        existing = { ...incoming, enabled: incoming.enabled && (selected === undefined || options.bundledMcpServersEnabled === true) }
        current.servers.push(existing)
        changed = true
      }
      if (existing.url !== incoming.url || existing.transport !== incoming.transport || existing.authType === 'oauth'
        || existing.oauth || existing.legacy?.unsupported?.length || existing.legacy?.config?.bearerTokenEnv) continue
      const currentAuthorization = authorization(existing.headers)
      if (currentAuthorization !== undefined && typeof currentAuthorization !== 'string') continue
      const baseline = previous.servers[name]
      const owned = currentAuthorization === undefined || currentAuthorization === nextAuthorization
        || baseline?.url === existing.url && [baseline.authorizationHash, baseline.previousAuthorizationHash].includes(digest(currentAuthorization))
      if (!owned) continue
      if (currentAuthorization !== nextAuthorization) {
        existing.headers = replaceAuthorization(existing.headers, nextAuthorization)
        if (existing.legacy?.baseline)
          existing.legacy.baseline.headers = replaceAuthorization(existing.legacy.baseline.headers, nextAuthorization)
        changed = true
      }
      previous.servers[name] = { url: incoming.url, authorizationHash: digest(nextAuthorization),
        previousAuthorizationHash: currentAuthorization === undefined ? undefined : digest(currentAuthorization) }
    }
    // Journal first and retain the accepted old fingerprint so interruption
    // between the two atomic writes can be recovered on the next startup.
    await saveJson(marker, previous)
    if (changed) await saveJson(target, current)
  }, { waitMs: 30000 })
}
