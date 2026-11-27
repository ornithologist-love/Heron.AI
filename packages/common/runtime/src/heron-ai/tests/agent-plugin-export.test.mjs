import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { crc32 } from 'node:zlib'
import { unzipSync } from 'fflate'
import { AGENT_PLUGIN_EXPORT_FORMATS, exportAgentPlugin } from '../agent-plugins/export.mjs'
import { MCP_SCHEMA, PLUGIN_SCHEMA, readAgentPlugin } from '../agent-plugins/manifest.mjs'

// Anchor: Docs/architecture/extensions.md#导出-agent-plugin

const fake = {
  bearer: 'fixture-bearer-3a240f4171',
  oauth: 'fixture-oauth-6d9205cf01',
  secret: 'fixture-secret-aa02e801ad',
  query: 'fixture-query-b05771a318',
  env: 'fixture-env-8dcefd3088',
  hidden: 'fixture-hidden-8cc740f211',
}
const decode = value => Buffer.from(value).toString()
const json = (archive, file) => JSON.parse(decode(archive[file]))

const logo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFBQIAQeHbGgAAAABJRU5ErkJggg==', 'base64')

function pngWithMetadata(comment) {
  const data = Buffer.from('Comment\0' + comment)
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length)
  chunk.write('tEXt', 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4)
  return Buffer.concat([logo.subarray(0, -12), chunk, logo.subarray(-12)])
}

async function fixture(t, includeBearerInExport = false) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'agent-plugin-export-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const root = path.join(scratch, 'package')
  const hostRoot = path.join(scratch, 'host')
  const put = async (file, value) => {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value))
  }
  await put(path.join(root, 'agent-plugin.json'), {
    $schema: PLUGIN_SCHEMA, name: 'fixture-suite', version: '1.2.3', description: 'Fixture suite',
    extensions: {
      'example.test': { clientSecret: fake.secret },
      'io.heron-ai': {
        title: 'Fixture Suite',
        cards: [{ id: 'fixture-suite', title: 'Fixture Suite', icon: './assets/fixture.png', servers: ['oauth', 'internal'] }],
        servers: {
          oauth: { authType: 'oauth', clientSecret: fake.secret },
          internal: { existingId: 'native-internal', includeBearerInExport },
          hostOnly: { existingId: 'native-host' },
        },
      },
    },
  })
  await put(path.join(root, 'mcp.json'), {
    $schema: MCP_SCHEMA,
    mcpServers: {
      oauth: {
        type: 'streamable-http', url: 'https://example.test/tools?access_token=' + fake.query,
        headers: { Authorization: 'Bearer ' + fake.oauth },
      },
      remote: {
        type: 'streamable-http', url: 'https://example.test/static',
        headers: { Authorization: 'Bearer ' + fake.bearer },
      },
      local: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/scripts/helper.mjs'], env: { API_TOKEN: fake.env } },
    },
  })
  await put(path.join(root, 'assets', 'fixture.png'), pngWithMetadata(fake.secret))
  await put(path.join(root, 'skills', 'fixture-skill', 'SKILL.md'), '---\nname: fixture-skill\ndescription: A placeholder skill\n---\nTest tools.')
  await put(path.join(root, 'skills', 'fixture-skill', 'references', 'guide.md'), 'A supporting reference.')
  await put(path.join(root, 'skills', 'fixture-skill', 'references', 'legacy.md'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))
  await put(path.join(root, 'skills', 'fixture-skill', '.env'), 'API_TOKEN=' + fake.hidden)
  await put(path.join(root, 'scripts', 'helper.mjs'), 'const token = process.env.API_TOKEN\nconsole.log(token !== undefined)')
  await put(path.join(hostRoot, 'heron-ai', 'content', 'bundled-plugins.json'), ['native-tools'])
  await put(path.join(hostRoot, 'node_modules', 'native-tools', 'package.json'), { heronAi: { content: { 'mcp-config.json': 'mcp.json' } } })
  await put(path.join(hostRoot, 'node_modules', 'native-tools', 'mcp.json'), {
    mcpServers: {
      'native-internal': { url: 'http://192.0.2.1/mcp', auth: 'bearer', bearerToken: fake.bearer, bearerTokenEnv: 'INTERNAL_MCP_TOKEN' },
      'unrelated': { url: 'https://example.test/unrelated' },
    },
  })
  return { scratch, root, options: { bundled: true, hostRoot }, put }
}

test('four export presets reconstruct safe layouts from an embedded plugin', async t => {
  const { scratch, root, options, put } = await fixture(t)
  for (const format of AGENT_PLUGIN_EXPORT_FORMATS) {
    const { fileName, bytes } = await exportAgentPlugin(root, { ...options, format })
    assert.equal(fileName, 'fixture-suite' + (format === 'standard' ? '' : '-' + format) + '.zip')
    const archive = unzipSync(bytes)
    for (const [name, body] of Object.entries(archive)) {
      assert.equal(name, name.replaceAll('\\', '/'))
      assert.equal(name.includes('..'), false)
      for (const secret of Object.values(fake)) assert.equal(decode(body).includes(secret), false)
    }
    assert.ok(archive['skills/fixture-skill/SKILL.md'])
    assert.deepEqual(Buffer.from(archive['assets/logo.png']), logo)
    assert.ok(archive['skills/fixture-skill/references/guide.md'])
    assert.equal(decode(archive['skills/fixture-skill/references/legacy.md']), '中文')
    assert.equal(archive['skills/fixture-skill/.env'], undefined)
    assert.equal(archive['agent-plugin.json'], undefined)
    assert.match(decode(archive['README.md']), /fixture-skill/)
    if (format === 'standard') {
      const unpacked = path.join(scratch, 'unpacked')
      for (const [name, body] of Object.entries(archive)) await put(path.join(unpacked, name), body)
      const diagnostics = []
      const loaded = await readAgentPlugin(unpacked, path.join(scratch, 'data'), { onDiagnostic: message => diagnostics.push(message) })
      assert.deepEqual(diagnostics, [])
      assert.equal(loaded.name, 'fixture-suite')
      assert.equal(loaded.icon, 'data:image/png;base64,' + logo.toString('base64'))
      assert.deepEqual(loaded.skills.map(skill => skill.name), ['fixture-skill'])
      assert.deepEqual(loaded.servers.map(({ key }) => key), ['oauth', 'remote', 'local'])
      assert.deepEqual(json(archive, 'mcp.json').mcpServers.oauth, { type: 'streamable-http', url: 'https://example.test/tools' })
      assert.match(decode(archive['README.md']), /Requires HTTPS/)
    }
    if (format === 'claude-code') {
      const manifest = json(archive, '.claude-plugin/plugin.json')
      assert.equal(manifest.name, 'fixture-suite')
      assert.equal(manifest.displayName, 'Fixture Suite')
      assert.equal(manifest.icon, './assets/logo.png')
      const { internal, oauth, local } = json(archive, '.mcp.json').mcpServers
      assert.equal(internal.headers.Authorization, 'Bearer ${INTERNAL_MCP_TOKEN}')
      assert.deepEqual(oauth, { type: 'http', url: 'https://example.test/tools' })
      assert.deepEqual(local.args, ['${CLAUDE_PLUGIN_ROOT}/scripts/helper.mjs'])
    }
    if (format === 'codex') {
      const manifest = json(archive, '.codex-plugin/plugin.json')
      assert.equal(manifest.interface.displayName, 'Fixture Suite')
      assert.equal(manifest.skills, './skills/')
      assert.equal(manifest.mcpServers, './.mcp.json')
      assert.equal(manifest.interface.logo, './assets/logo.png')
      const marketplace = json(archive, '.agents/plugins/marketplace.json')
      assert.equal(marketplace.name, 'fixture-suite-local')
      assert.deepEqual(marketplace.plugins[0].source, { source: 'local', path: './' })
      const { internal, oauth, local, remote, ...other } = json(archive, '.mcp.json').mcpServers
      assert.deepEqual(internal, { url: 'http://192.0.2.1/mcp', bearer_token_env_var: 'INTERNAL_MCP_TOKEN' })
      assert.deepEqual(oauth, { url: 'https://example.test/tools', auth: 'oauth' })
      assert.deepEqual(local, { command: 'node', args: ['./scripts/helper.mjs'], cwd: './', env_vars: ['API_TOKEN'] })
      assert.equal(remote.bearer_token_env_var, 'FIXTURE_SUITE_REMOTE_TOKEN')
      assert.deepEqual(other, {})
      assert.equal(archive['config.toml'], undefined)
      assert.equal(archive['plugin.json'], undefined)
      assert.match(decode(archive['README.md']), /codex plugin add fixture-suite@fixture-suite-local/)
    }
    if (format === 'antigravity') {
      const manifest = json(archive, 'plugin.json')
      assert.equal(manifest.name, 'fixture-suite')
      assert.equal(manifest.displayName, 'Fixture Suite')
      assert.equal(manifest.logo, 'assets/logo.png')
      const servers = json(archive, 'mcp_config.json').mcpServers
      assert.equal(servers.internal.serverUrl, 'http://192.0.2.1/mcp')
      assert.equal(servers.internal.variables[0].name, 'INTERNAL_MCP_TOKEN')
      assert.equal(servers.oauth.serverUrl, 'https://example.test/tools')
      assert.equal(servers.remote.variables[0].name, 'FIXTURE_SUITE_REMOTE_TOKEN')
    }
  }
})

test('an included file containing possible credentials aborts export without showing the value', async t => {
  const { root, options, put } = await fixture(t)
  const file = path.join(root, 'skills', 'fixture-skill', 'references', 'guide.md')
  await put(file, 'The source credential is ' + fake.secret)
  await assert.rejects(exportAgentPlugin(root, options), error => error.name === 'AgentPluginExportError'
    && error.message.includes('possible credential') && !error.message.includes(fake.secret))
  await put(file, 'clientSecret: "another-unrelated-fixture-secret"')
  await assert.rejects(exportAgentPlugin(root, options), /possible credential/)
})

test('every format packages the explicitly selected bundled bearer in its transport configuration', async t => {
  const { root, options } = await fixture(t, true)
  const bearer = { Authorization: 'Bearer ' + fake.bearer }
  for (const format of AGENT_PLUGIN_EXPORT_FORMATS) {
    const { bytes } = await exportAgentPlugin(root, { ...options, format })
    const archive = unzipSync(bytes)
    const credentialFile = format === 'standard' ? 'scripts/portable-mcp-servers.json'
      : format === 'antigravity' ? 'mcp_config.json' : '.mcp.json'
    const config = json(archive, credentialFile)
    const url = 'http://192.0.2.1/mcp'
    if (format === 'standard') {
      assert.deepEqual(config, { internal: { url, headers: bearer } })
      assert.deepEqual(json(archive, 'mcp.json').mcpServers.internal, {
        type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/scripts/portable-mcp-stdio.mjs', 'internal'],
      })
      assert.ok(archive['scripts/portable-mcp-stdio.mjs'])
    } else if (format === 'codex') {
      assert.deepEqual(config.mcpServers.internal, { url, http_headers: bearer })
    } else if (format === 'claude-code') {
      assert.deepEqual(config.mcpServers.internal, { type: 'http', url, headers: bearer })
    } else {
      assert.deepEqual(config.mcpServers.internal, { serverUrl: url, headers: bearer })
    }
    assert.equal(decode(archive['README.md']).includes('INTERNAL_MCP_TOKEN'), false)
    for (const [file, body] of Object.entries(archive)) {
      if (file !== credentialFile) assert.equal(decode(body).includes(fake.bearer), false)
      assert.equal(decode(body).includes(fake.oauth), false)
    }
  }
  await copyFile(path.join(root, 'agent-plugin.json'), path.join(root, 'plugin.json'))
  const unbundled = await exportAgentPlugin(root, { format: 'codex' })
  assert.equal(decode(unzipSync(unbundled.bytes)['.mcp.json']).includes(fake.bearer), false)
})

test('a directory link inside a skill cannot enter the ZIP', async t => {
  const { scratch, root, options, put } = await fixture(t)
  const outside = path.join(scratch, 'outside')
  await put(path.join(outside, 'guide.md'), 'outside the plugin')
  const link = path.join(root, 'skills', 'fixture-skill', 'assets')
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(exportAgentPlugin(root, options), /symbolic links/)
})
