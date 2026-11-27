// Anchor: Docs/architecture/extensions.md
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { mergeAgentConnection } from '../agent-plugins/connections.mjs'
import { MCP_SCHEMA, PLUGIN_SCHEMA, readAgentPlugin, readAgentSkill } from '../agent-plugins/manifest.mjs'
import { createAgentPluginRegistry } from '../agent-plugins/registry.mjs'

async function fixture(t) {
  const temp = await realpath(os.tmpdir())
  const directory = await mkdtemp(path.join(temp, 'heron-agent-plugin-'))
  t.after(async () => {
    const target = await realpath(directory)
    assert.equal(path.dirname(target), temp)
    assert.ok(path.basename(target).startsWith('heron-agent-plugin-'))
    await rm(target, { recursive: true, force: true })
  })
  const root = path.join(directory, 'package')
  const data = path.join(directory, 'data')
  await mkdir(root)
  const write = async (file, value) => {
    const target = path.join(root, file)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, typeof value === 'string' ? value : JSON.stringify(value))
  }
  const manifest = fields => write('plugin.json', { $schema: PLUGIN_SCHEMA, name: 'local.demo', ...fields })
  const mcp = mcpServers => write('mcp.json', { $schema: MCP_SCHEMA, mcpServers })
  return { directory, root, data, write, manifest, mcp }
}

test('portable plugin manifest isolates non-fatal fields and rejects invalid required metadata', async t => {
  const f = await fixture(t)
  const messages = []
  const options = { onDiagnostic: message => messages.push(message) }
  await f.manifest({ version: 'informal build', unknown: ['ignored'], extensions: { 'example.unimplemented': true } })
  const plugin = await readAgentPlugin(f.root, f.data, options)
  assert.equal(plugin.name, 'local.demo')
  assert.equal(plugin.version, 'informal build')
  assert.deepEqual(plugin.cards, [])
  assert.deepEqual(messages, ['plugin.json ignores unknown field unknown'])
  await f.manifest({ name: 'bad--name' })
  await assert.rejects(() => readAgentPlugin(f.root, f.data), /invalid name/)
  await f.manifest({ name: 'valid\n' })
  await assert.rejects(() => readAgentPlugin(f.root, f.data), /invalid name/)
  await f.manifest({ $schema: 'https://example.invalid/other-plugin-schema' })
  await assert.rejects(() => readAgentPlugin(f.root, f.data), /unsupported \$schema/)
  await f.manifest({ author: { name: 'Demo', privateExtra: true } })
  await assert.rejects(() => readAgentPlugin(f.root, f.data), /author has invalid or unknown fields/)
})

test('the embedded manifest filename is accepted only for bundled Agent Plugins', async t => {
  const f = await fixture(t)
  await f.write('agent-plugin.json', { $schema: PLUGIN_SCHEMA, name: 'embedded.demo' })
  assert.equal((await readAgentPlugin(f.root, f.data, { bundled: true })).name, 'embedded.demo')
  await assert.rejects(() => readAgentPlugin(f.root, f.data), { code: 'ENOENT' })
})

test('stdio expansion preserves opaque arguments and rejects filesystem escapes independently', async t => {
  const f = await fixture(t)
  const messages = []
  await f.manifest({})
  await f.write('bin/fake.node', '')
  await mkdir(path.join(f.data, 'work'), { recursive: true })
  const outside = path.join(f.directory, 'outside')
  await mkdir(outside)
  await writeFile(path.join(outside, 'fake.node'), '')
  await symlink(outside, path.join(f.root, 'escaped'), 'junction')
  await f.mcp({
    portable: {
      type: 'stdio', command: './bin/fake.node', cwd: '${PLUGIN_DATA}/work',
      args: ['${PLUGIN_ROOT}/file.json', '${OTHER_VAR}', '../opaque'], env: { CACHE: '${PLUGIN_DATA}/cache' },
    },
    escapedCommand: { type: 'stdio', command: './escaped/fake.node' },
    escapedCwd: { type: 'stdio', command: 'demo', cwd: '${PLUGIN_DATA}/../package' },
    reservedEnv: { type: 'stdio', command: 'demo', env: { PLUGIN_ROOT: 'other' } },
  })
  const plugin = await readAgentPlugin(f.root, f.data, { onDiagnostic: message => messages.push(message) })
  assert.deepEqual(plugin.servers.map(item => item.key), ['portable'])
  const { entry } = plugin.servers[0]
  const root = await realpath(f.root)
  const data = await realpath(f.data)
  assert.equal(entry.command, path.join(root, 'bin', 'fake.node'))
  assert.equal(entry.cwd, path.join(data, 'work'))
  assert.deepEqual(entry.args, [`${root}/file.json`, '${OTHER_VAR}', '../opaque'])
  assert.deepEqual(entry.env, { CACHE: `${data}/cache`, PLUGIN_ROOT: root, PLUGIN_DATA: data })
  assert.equal(messages.filter(item => item.includes('escapes its root')).length, 2)
  assert.ok(messages.some(item => item.includes('cannot set PLUGIN_ROOT or PLUGIN_DATA')))
})

test('MCP URL and headers stay literal and bad servers preserve healthy transports', async t => {
  const f = await fixture(t)
  const messages = []
  await f.manifest({ extensions: { 'io.heron-ai': {
    servers: { live: { authType: 'oauth', scopes: ['demo.read'] }, previous: { existingId: 'saved-connector' } },
    cards: [{ id: 'our-cards', title: 'Services', servers: ['live', 'previous'] }],
  } } })
  await f.mcp({
    live: { type: 'streamable-http', url: 'https://example.invalid/mcp', headers: { 'X-Demo': '${PLUGIN_ROOT}' } },
    liveLocal: { type: 'sse', url: 'http://127.0.0.1:1234/events' },
    duplicate: { type: 'streamable-http', url: 'https://example.invalid/mcp', headers: { Foo: '1', foo: '2' } },
    unsecured: { type: 'streamable-http', url: 'http://example.invalid/mcp' },
    disguised: { type: 'streamable-http', url: 'http://127.example.invalid/mcp' },
    userInfo: { type: 'streamable-http', url: 'https://alice@example.invalid/mcp' },
  })
  const plugin = await readAgentPlugin(f.root, f.data, { onDiagnostic: message => messages.push(message) })
  assert.deepEqual(plugin.servers.map(item => item.key), ['live', 'liveLocal', 'previous'])
  const { headers, oauth, enabled } = plugin.servers[0].entry
  assert.deepEqual(headers, { 'X-Demo': '${PLUGIN_ROOT}' })
  assert.deepEqual(oauth, { scopes: ['demo.read'] })
  assert.equal(enabled, false)
  assert.equal(plugin.servers[1].entry.transport, 'sse')
  assert.equal(plugin.servers[2].existingId, 'saved-connector')
  assert.equal(plugin.servers[2].entry, undefined)
  assert.deepEqual(plugin.cards[0].servers, ['live', 'previous'])
  assert.equal(messages.length, 4)
})

test('skill discovery reads only immediate valid skills, even after an MCP failure', async t => {
  const f = await fixture(t)
  const messages = []
  await f.manifest({})
  await f.write('mcp.json', { $schema: 'bad', mcpServers: {} })
  await f.write('skills/hello/SKILL.md', '---\nname: hello\ndescription: A greeting skill.\nuser-invocable: false\n---\nUse it.\n')
  await f.write('skills/bad/SKILL.md', '---\nname: mismatched\ndescription: Invalid.\n---\n')
  await f.write('skills/container/nested/SKILL.md', '---\nname: nested\ndescription: Too deep.\n---\n')
  const plugin = await readAgentPlugin(f.root, f.data, { onDiagnostic: message => messages.push(message) })
  assert.deepEqual(plugin.servers, [])
  assert.deepEqual(plugin.skills.map(item => item.name), ['hello'])
  assert.deepEqual(plugin.skills[0].invocation, { modelInvocable: true, userInvocable: false })
  assert.equal(messages.length, 2)
  const skill = await readAgentSkill(f.root, plugin.skills[0])
  assert.equal(skill.content, 'Use it.')
  assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: false })
})

test('registered connectors retain an existing OAuth grant only for the same endpoint', () => {
  const original = 'https://mock.example.invalid/mcp'
  const entry = {
    serverName: 'fixture', managedConnector: 'fixture:main', agentPlugin: 'fixture:main',
    url: original, transport: 'streamable-http', authType: 'oauth', enabled: false, oauth: { scopes: ['read'] },
  }
  const existing = {
    serverName: 'fixture', managedConnector: 'fixture-legacy', url: original, transport: 'streamable-http',
    authType: 'oauth', enabled: true, oauth: { clientId: 'mock-client', tokens: { accessToken: 'mock-grant' } },
  }
  const definition = { entry, legacyId: 'fixture', legacyName: 'fixture-legacy' }
  const updated = mergeAgentConnection(existing, definition)
  assert.equal(updated.enabled, true)
  assert.deepEqual(updated.oauth, { ...existing.oauth, scopes: ['read'] })

  const moved = { ...entry, url: 'https://next.example.invalid/mcp' }
  assert.deepEqual(mergeAgentConnection(existing, { ...definition, entry: moved, previousUrl: original }), {
    ...moved, enabled: true,
  })
  assert.deepEqual(mergeAgentConnection(updated, { entry: moved }), { ...moved, enabled: true })
  assert.equal(mergeAgentConnection({ ...existing, managedConnector: 'unrelated' }, definition), undefined)
})

test('import preview rejects Agent Plugins with invalid MCP configuration', async t => {
  const f = await fixture(t)
  const home = path.join(f.directory, 'home')
  const hostRoot = path.join(f.directory, 'host')
  await mkdir(home, { recursive: true })
  await mkdir(hostRoot, { recursive: true })
  await f.manifest({})
  await f.write('mcp.json', { $schema: 'https://example.invalid/bad', mcpServers: {} })
  const ctx = {
    logger: { warn() {} },
    skills: { registerProvider() { return () => {} } },
    effect() {},
  }
  const registry = await createAgentPluginRegistry(ctx, { home, hostRoot }, async () => {})
  await assert.rejects(() => registry.preview({ directory: f.root }), /mcp\.json/)
})
