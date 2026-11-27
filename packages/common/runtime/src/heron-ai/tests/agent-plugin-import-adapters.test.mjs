import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { discoverAgentPluginCandidates, normalizeAgentPluginSource, resolveAgentPluginCandidate } from '../agent-plugins/import-adapters.mjs'
import { MCP_SCHEMA, PLUGIN_SCHEMA, readAgentPlugin } from '../agent-plugins/manifest.mjs'

// Anchor: Docs/architecture/extensions.md

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-plugin-adapter-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  async function put(relative, value) {
    const file = path.join(root, relative)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value))
  }
  async function read(relative) {
    return JSON.parse(await readFile(path.join(root, relative), 'utf8'))
  }
  return { root, put, read }
}

const sampleSkill = '---\nname: demo-skill\ndescription: A mock skill\n---\nFixture text.\n'
const genericSecret = 'fixture-source-credential'

test('Claude Code installed manifest resolves and packaged stdio paths map without running', async t => {
  const { root, put, read } = await workspace(t)
  const pluginPath = '.claude/plugins/cache/test-directory/fixture-plugin/1.0.0'
  await put('.claude/plugins/installed_plugins.json', {
    version: 2,
    plugins: {
      'fixture-plugin@test-directory': [{ installPath: path.join(root, pluginPath) }],
      'outside@test-directory': [{ installPath: path.join(root, 'outside') }],
    },
  })
  await put('outside/.claude-plugin/plugin.json', { name: 'outside' })
  await put(pluginPath + '/.claude-plugin/plugin.json', { name: 'fixture-plugin', version: '1.0.0', mcpServers: './config/mcp.json' })
  await put(pluginPath + '/.mcp.json', { mcpServers: { docs: { type: 'http', url: 'https://example.test/mcp', oauth: { clientSecret: genericSecret } } } })
  await put(pluginPath + '/config/mcp.json', {
    mcpServers: {
      runner: {
        type: 'stdio', command: '${CLAUDE_PLUGIN_ROOT}/scripts/tool.mjs',
        args: ['${CLAUDE_PLUGIN_DATA}/fixture'],
        env: { TEST_MODE: 'fixture', API_TOKEN: genericSecret },
      },
    },
  })
  await put(pluginPath + '/scripts/tool.mjs', 'throw new Error("must not execute during import")')
  await put(pluginPath + '/skills/demo-skill/SKILL.md', sampleSkill)
  const options = { homeDir: root }
  const [candidate] = await discoverAgentPluginCandidates('claude-code', options)
  assert.deepEqual(await discoverAgentPluginCandidates('claude-code', options), [candidate])
  assert.equal(candidate.name, 'fixture-plugin')
  assert.deepEqual(await resolveAgentPluginCandidate('claude-code', candidate.id, options), {
    directory: path.join(root, pluginPath), source: 'claude-code',
  })
  await assert.rejects(resolveAgentPluginCandidate('claude-code', 'outside', options), /no longer available/)
  const destination = path.join(root, 'normalized')
  const imported = await normalizeAgentPluginSource(path.join(root, pluginPath), destination, { source: 'claude-code' })
  assert.equal(imported.format, 'claude-code')
  assert.equal(imported.warnings.length, 1)
  const manifest = await read('normalized/plugin.json')
  const config = await read('normalized/mcp.json')
  assert.equal(manifest.$schema, PLUGIN_SCHEMA)
  assert.deepEqual(manifest.extensions['io.heron-ai'].servers, {
    docs: { authType: 'oauth' }, runner: { enabled: false },
  })
  assert.deepEqual(config.mcpServers.runner, {
    type: 'stdio', command: './scripts/tool.mjs', args: ['${PLUGIN_DATA}/fixture'], env: { TEST_MODE: 'fixture' },
  })
  assert.equal(JSON.stringify({ config, manifest }).includes(genericSecret), false)
  const diagnostics = []
  const loaded = await readAgentPlugin(destination, path.join(root, 'managed-data'), { onDiagnostic: message => diagnostics.push(message) })
  assert.deepEqual(diagnostics, [])
  assert.deepEqual(loaded.skills.map(skill => skill.name), ['demo-skill'])
})

test('Antigravity imports public MCP and skills while omitting private binaries', async t => {
  const { root, put, read } = await workspace(t)
  const pluginPath = '.gemini/config/plugins/fixture-agy'
  await put(pluginPath + '/plugin.json', { name: 'fixture-agy' })
  await put(pluginPath + '/mcp_config.json', {
    mcpServers: {
      docs: { serverUrl: 'https://example.test/mcp' },
      local: { command: './scripts/opaque.exe' },
    },
  })
  await put(pluginPath + '/scripts/opaque.exe', Buffer.from([77, 90, 0, 0]))
  await put(pluginPath + '/skills/demo-skill/SKILL.md', sampleSkill)
  const options = { homeDir: root }
  const [candidate] = await discoverAgentPluginCandidates('antigravity', options)
  const resolved = await resolveAgentPluginCandidate('antigravity', candidate.id, options)
  const imported = await normalizeAgentPluginSource(resolved.directory, path.join(root, 'normalized'), resolved)
  assert.equal(imported.format, 'antigravity')
  assert.match(imported.warnings.join('\n'), /binary files were skipped/)
  assert.match(imported.warnings.join('\n'), /local was skipped/)
  assert.deepEqual((await read('normalized/mcp.json')).mcpServers, {
    docs: { type: 'streamable-http', url: 'https://example.test/mcp' },
  })
  await assert.rejects(readFile(path.join(root, 'normalized/scripts/opaque.exe')), { code: 'ENOENT' })
})

test('Codex normalizes its local TOML and skill directory without consuming other profile files', async t => {
  const { root, put, read } = await workspace(t)
  await put('.codex/config.toml', [
    '[mcp_servers."demo-http"]', 'url = "https://example.test/mcp"', 'bearer_token_env_var = "EXAMPLE_TOKEN"',
    '[mcp_servers.local]', 'command = "node"', 'args = ["fixture.mjs"]',
    'env = { TEST_MODE = "fixture", API_TOKEN = "' + genericSecret + '" }',
    '[mcp_servers.internal]', 'url = "http://192.0.2.1/mcp"',
  ].join('\n'))
  await put('.codex/skills/demo-skill/SKILL.md', sampleSkill)
  await put('.codex/auth.json', { secret: genericSecret })
  const options = { homeDir: root }
  assert.deepEqual(await discoverAgentPluginCandidates('codex', options), [{ id: 'codex-local', name: 'Codex' }])
  const resolved = await resolveAgentPluginCandidate('codex', 'codex-local', options)
  const destination = path.join(root, 'normalized')
  const imported = await normalizeAgentPluginSource(resolved.directory, destination, resolved)
  assert.equal(imported.format, 'codex')
  assert.match(imported.warnings.join('\n'), /HTTPS is required/)
  const checked = await read('normalized/mcp.json')
  assert.deepEqual(checked.mcpServers, {
    'demo-http': { type: 'streamable-http', url: 'https://example.test/mcp' },
    local: { type: 'stdio', command: 'node', args: ['fixture.mjs'], env: { TEST_MODE: 'fixture' } },
  })
  assert.deepEqual((await read('normalized/plugin.json')).extensions['io.heron-ai'].servers, {
    'demo-http': { enabled: false }, local: { enabled: false },
  })
  await assert.rejects(readFile(path.join(destination, 'auth.json')), { code: 'ENOENT' })
  assert.equal(await readFile(path.join(destination, 'skills/demo-skill/SKILL.md'), 'utf8'), sampleSkill)
})

test('Codex bundled portable manifest keeps identity, grouping and OAuth with its TOML overlay', async t => {
  const { root, put, read } = await workspace(t)
  await put('input/plugin.json', {
    $schema: PLUGIN_SCHEMA, name: 'example-plugin',
    extensions: { 'io.heron-ai': {
      servers: { demo: { authType: 'oauth', oauth: { clientSecret: genericSecret } } },
      cards: [{ id: 'example-group', title: 'Example', servers: ['demo'] }],
    } },
  })
  await put('input/mcp.json', { $schema: MCP_SCHEMA, mcpServers: { demo: { type: 'streamable-http', url: 'https://example.test/mcp' } } })
  await put('input/config.toml', '[mcp_servers.demo]\nurl = "https://example.test/mcp"\n[mcp_servers.extra]\nurl = "https://other.example/mcp"\n')
  const imported = await normalizeAgentPluginSource(path.join(root, 'input'), path.join(root, 'normalized'))
  assert.equal(imported.format, 'codex')
  const manifest = await read('normalized/plugin.json')
  assert.equal(manifest.name, 'example-plugin')
  assert.deepEqual(manifest.extensions['io.heron-ai'], {
    servers: { demo: { authType: 'oauth' } },
    cards: [{ id: 'example-group', title: 'Example', servers: ['demo'] }],
  })
  assert.deepEqual(Object.keys((await read('normalized/mcp.json')).mcpServers), ['demo', 'extra'])
})

test('standard invalid configuration and incomplete skill declaration are reported', async t => {
  const { root, put } = await workspace(t)
  await put('input/plugin.json', { $schema: PLUGIN_SCHEMA, name: 'example-plugin' })
  const input = path.join(root, 'input')
  const destination = path.join(root, 'normalized')
  await put('input/mcp.json', '{')
  await assert.rejects(normalizeAgentPluginSource(input, destination), /mcp.json is not valid JSON/)
  await put('input/mcp.json', { $schema: MCP_SCHEMA, mcpServers: { missing: { url: 'https://example.test/mcp' } } })
  await assert.rejects(normalizeAgentPluginSource(input, destination), /MCP missing.*invalid or unknown fields/)
  await put('input/mcp.json', { $schema: MCP_SCHEMA, mcpServers: {} })
  await put('input/skills/incomplete/reference.md', 'No entry')
  await assert.rejects(normalizeAgentPluginSource(input, destination), /missing its SKILL.md/)
})


test('standard portable package resources remain available for its relative stdio executable', async t => {
  const { root, put } = await workspace(t)
  await put('input/plugin.json', { $schema: PLUGIN_SCHEMA, name: 'root-files' })
  await put('input/mcp.json', {
    $schema: MCP_SCHEMA,
    mcpServers: { tool: { type: 'stdio', command: './tool.mjs', args: ['${PLUGIN_ROOT}/schema.json'] } },
  })
  await put('input/tool.mjs', 'throw new Error("must not execute during import")')
  await put('input/schema.json', { example: true })
  await put('input/.env', 'API_TOKEN=' + genericSecret)
  const destination = path.join(root, 'normalized')
  const imported = await normalizeAgentPluginSource(path.join(root, 'input'), destination)
  assert.equal(imported.format, 'standard')
  await readFile(path.join(destination, 'tool.mjs'))
  await readFile(path.join(destination, 'schema.json'))
  await assert.rejects(readFile(path.join(destination, '.env')), { code: 'ENOENT' })
  const diagnostics = []
  await readAgentPlugin(destination, path.join(root, 'managed-data'), { onDiagnostic: message => diagnostics.push(message) })
  assert.deepEqual(diagnostics, [])
})

test('standalone Antigravity plugin with only skills is discovered by its native manifest', async t => {
  const { root, put } = await workspace(t)
  await put('input/plugin.json', { name: 'skills-only' })
  await put('input/skills/demo-skill/SKILL.md', sampleSkill)
  const imported = await normalizeAgentPluginSource(path.join(root, 'input'), path.join(root, 'normalized'))
  assert.equal(imported.format, 'antigravity')
  assert.deepEqual(imported.warnings, [])
})
