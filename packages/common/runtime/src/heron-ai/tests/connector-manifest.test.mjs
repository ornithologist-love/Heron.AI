// Anchor: Docs/architecture/extensions.md#托管-mcp-connector
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { readConnectorManifest } from '../connector-manifest.mjs'

const commonDir = fileURLToPath(new URL('../../../../', import.meta.url))

test('legacy declarative OAuth connector preserves its identity and previous endpoint', () => {
  const id = 'example-connector'
  const url = 'https://example.com/mcp'
  const previousUrl = 'https://example.com/old-mcp'
  const parsed = readConnectorManifest(commonDir, [{
    id, title: 'Example',
    servers: [{ id, displayName: 'Example Connector', transport: 'streamable-http', url, previousUrl, authType: 'oauth', enabled: false }],
  }])
  assert.ok(parsed.ids.has(id))
  assert.ok(parsed.presentations.has(id))
  const def = parsed.definitions.get(id)
  assert.equal(def.entry.serverName, id)
  assert.equal(def.entry.displayName, 'Example Connector')
  assert.equal(def.entry.transport, 'streamable-http')
  assert.equal(def.entry.url, url)
  assert.equal(def.entry.authType, 'oauth')
  assert.equal(def.entry.enabled, false)
  assert.equal(def.previousUrl, previousUrl)
  assert.equal(def.legacyDisplayName, undefined)
})

test('readConnectorManifest defaults displayName to stable server.id when omitted', () => {
  const parsed = readConnectorManifest(commonDir, [{
    id: 'custom-card',
    title: 'Mutable Display Title',
    servers: [{ id: 'stable-server-id', transport: 'stdio', command: 'npx', args: ['-y', 'demo'] }],
  }])
  const def = parsed.definitions.get('stable-server-id')
  assert.ok(def)
  assert.equal(def.entry.displayName, 'stable-server-id')
  assert.equal(def.legacyDisplayName, 'Mutable Display Title')
  assert.deepEqual(def.entry.args, ['-y', 'demo'])
})

test('readConnectorManifest rejects invalid declarative endpoint definitions', () => {
  assert.throws(() => readConnectorManifest(commonDir, [{
    id: 'bad-http',
    title: 'Bad HTTP',
    servers: [{ id: 'bad-http', transport: 'streamable-http', url: 'ftp://example.com' }],
  }]), /requires an http\(s\) url/)

  assert.throws(() => readConnectorManifest(commonDir, [{
    id: 'bad-stdio',
    title: 'Bad Stdio',
    servers: [{ id: 'bad-stdio', transport: 'stdio' }],
  }]), /requires a command/)
})
