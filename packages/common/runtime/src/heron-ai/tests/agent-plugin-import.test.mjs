import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { zipSync } from 'fflate'
import { createAgentPluginRegistry } from '../agent-plugins/registry.mjs'
import { MCP_SCHEMA, PLUGIN_SCHEMA } from '../agent-plugins/manifest.mjs'

// Anchor: Docs/architecture/extensions.md#导入-agent-plugin

const manifest = JSON.stringify({ $schema: PLUGIN_SCHEMA, name: 'fixture-import' })
const config = JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: { local: { type: 'stdio', command: 'node', args: ['--version'] } } })
const skill = '---\nname: fixture-skill\ndescription: A fixture skill\n---\nFixture text.'
const zip = () => zipSync({
  'fixture-import/plugin.json': Buffer.from(manifest),
  'fixture-import/mcp.json': Buffer.from(config),
  'fixture-import/skills/fixture-skill/SKILL.md': Buffer.from(skill),
})

async function fixture(t, onChange = async () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-plugin-preview-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = path.join(root, 'state')
  const hostRoot = path.join(root, 'host')
  const target = path.join(home, 'agent-plugins', 'fixture-import')
  const dispose = []
  const ctx = {
    logger: { warn() {} },
    skills: { registerProvider() { return () => {} } },
    effect(fn) { dispose.push(fn()) },
  }
  t.after(() => dispose.forEach(fn => fn()))
  const registry = await createAgentPluginRegistry(ctx, { home, hostRoot }, onChange)
  return { registry, root, target }
}

test('a wrapped ZIP installs only the selected preview by local confirmation', async t => {
  const { registry, root, target } = await fixture(t)
  const file = path.join(root, 'source.zip')
  await writeFile(file, zip())
  const preview = await registry.preview({ directory: file })
  assert.equal(preview.format, 'standard')
  assert.deepEqual(preview.servers, [{ id: 'local', command: 'node', args: ['--version'] }])
  assert.deepEqual(preview.skills, [{ name: 'fixture-skill' }])
  const request = { id: preview.id, serverIds: ['local'], skillNames: ['fixture-skill'], allowStdio: false }
  await assert.rejects(registry.commit(request), /stdio/)
  assert.deepEqual(registry.list(), [])
  await writeFile(file, Buffer.from('Source changed after the preview.'))
  await registry.commit({ ...request, allowStdio: true })
  assert.equal(registry.list()[0].id, 'fixture-import')
  assert.equal(await readFile(path.join(target, 'skills', 'fixture-skill', 'SKILL.md'), 'utf8'), skill)
  await assert.rejects(registry.commit({ ...request, allowStdio: true }), /过期/)
  assert.equal(await readFile(file, 'utf8'), 'Source changed after the preview.')
})

test('selection excludes unconfirmed stdio and rejects corrupt skills at preview', async t => {
  const { registry, root, target } = await fixture(t)
  const source = path.join(root, 'broken')
  await mkdir(path.join(source, 'skills', 'fixture-skill'), { recursive: true })
  await writeFile(path.join(source, 'plugin.json'), manifest)
  await writeFile(path.join(source, 'skills', 'fixture-skill', 'SKILL.md'), 'Invalid metadata')
  await assert.rejects(registry.preview({ directory: source }), /SKILL\.md/)
  const preview = await registry.preview({ fileName: 'fixture.zip', zipBytes: zip() })
  await registry.commit({ id: preview.id, serverIds: [], skillNames: ['fixture-skill'], allowStdio: false })
  assert.deepEqual(JSON.parse(await readFile(path.join(target, 'mcp.json'), 'utf8')).mcpServers, {})
})

test('a failed activation rolls back the installed directory and keeps the source', async t => {
  const { registry, root, target } = await fixture(t, async plugins => {
    if (plugins.length) throw Error('fixture activation failed')
  })
  const file = path.join(root, 'source.zip')
  await writeFile(file, zip())
  const preview = await registry.preview({ directory: file })
  await assert.rejects(registry.commit({ id: preview.id, serverIds: [], skillNames: ['fixture-skill'], allowStdio: false }), /fixture activation failed/)
  await assert.rejects(readFile(path.join(target, 'plugin.json')), { code: 'ENOENT' })
  assert.deepEqual(registry.list(), [])
  assert.deepEqual(await readFile(file), Buffer.from(zip()))
})
