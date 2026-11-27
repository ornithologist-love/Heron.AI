// Anchor: Docs/architecture/extensions.md
// A composition entry may keep only some of a package's skills and MCP servers; selections fail closed.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pluginBundleInputs, selectedFile, selectedMcpServers, dropExcludedLinks } from '../scripts/plugin-bundles.mjs'
import { bundledPluginSelection, PRODUCT_BUNDLES } from '../packages/common/runtime/src/heron-ai/bundled-plugins.mjs'

test('a new payload default is selected once and preserves a later disable', () => {
  assert.ok(PRODUCT_BUNDLES.includes('dsh-google-connector'))
  const shipped = ['fixture-bundle']
  const initial = bundledPluginSelection({}, shipped)
  assert.ok(initial.bundles.includes('dsh-google-connector'))
  assert.ok(initial.bundles.includes(shipped[0]))

  const disabledProfile = {
    dsh: { profile: { bundles: initial.bundles.filter(name => name !== shipped[0]) } },
    heronAi: initial.metadata,
  }
  const next = bundledPluginSelection(disabledProfile, shipped)
  assert.deepEqual(next.bundles, disabledProfile.dsh.profile.bundles)
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heron-composition-'))
  const plugin = path.join(root, 'plugin')
  for (const skill of ['keep', 'drop']) {
    fs.mkdirSync(path.join(plugin, 'skills', skill), { recursive: true })
    fs.writeFileSync(path.join(plugin, 'skills', skill, 'SKILL.md'), '# ' + skill)
  }
  fs.mkdirSync(path.join(plugin, 'context'))
  fs.writeFileSync(path.join(plugin, 'context', 'mcp-config.json'), JSON.stringify({ mcpServers: { a: {}, b: { bearerTokenEnv: 'B' } } }))
  fs.writeFileSync(path.join(plugin, 'index.mjs'), '')
  fs.writeFileSync(path.join(plugin, 'patch.yml'), '')
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'demo', main: './index.mjs',
    dsh: { bundle: { patch: './patch.yml' } }, heronAi: { skills: 'skills/', content: { 'mcp-config.json': 'context/mcp-config.json' } } }))
  const write = entry => {
    const file = path.join(root, 'composition.json')
    fs.writeFileSync(file, JSON.stringify({ version: 1, plugins: [entry] }))
    return file
  }
  return { root, plugin, write }
}

test('a selection keeps only the named skills and MCP servers', () => {
  const { root, plugin, write } = fixture()
  try {
    const bundle = pluginBundleInputs(write({ path: 'plugin', skills: ['keep'], mcpServers: ['a'] }))
    const selection = bundle.selections.get(path.resolve(plugin))
    const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'package.json'), 'utf8'))
    assert.equal(selectedFile(manifest, selection, path.join('skills', 'keep', 'SKILL.md')), true)
    assert.equal(selectedFile(manifest, selection, path.join('skills', 'drop', 'SKILL.md')), false)
    assert.equal(selectedFile(manifest, selection, 'index.mjs'), true)
    assert.deepEqual(Object.keys(selectedMcpServers({ mcpServers: { a: {}, b: {} } }, selection).mcpServers), ['a'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a plain entry keeps the whole package', () => {
  const { root, write } = fixture()
  try { assert.equal(pluginBundleInputs(write('plugin')).selections.size, 0) }
  finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('selecting something the package does not ship fails the build', () => {
  const { root, write } = fixture()
  try {
    assert.throws(() => pluginBundleInputs(write({ path: 'plugin', skills: ['missing'] })), /Selected skill does not exist/)
    assert.throws(() => pluginBundleInputs(write({ path: 'plugin', mcpServers: ['missing'] })), /Selected MCP server does not exist/)
    assert.throws(() => pluginBundleInputs(write({ path: 'plugin', exclude: ['x'] })), /Invalid plugin composition manifest/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('an excluded file leaves the payload with the lines that link to it', () => {
  const { root, plugin, write } = fixture()
  try {
    fs.writeFileSync(path.join(plugin, 'skills', 'keep', 'SKILL.md'), '# keep\n| a | [x](references/x.md#top) |\n| b | [y](references/y.md) |\n')
    fs.mkdirSync(path.join(plugin, 'skills', 'keep', 'references'))
    for (const name of ['x', 'y']) fs.writeFileSync(path.join(plugin, 'skills', 'keep', 'references', name + '.md'), name)
    const excluded = 'skills/keep/references/x.md'
    const bundle = pluginBundleInputs(write({ path: 'plugin', excludeFiles: [excluded] }))
    const selection = bundle.selections.get(path.resolve(plugin))
    const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'package.json'), 'utf8'))
    assert.equal(selectedFile(manifest, selection, path.normalize(excluded)), false)
    assert.equal(selectedFile(manifest, selection, path.normalize('skills/keep/references/y.md')), true)
    dropExcludedLinks(plugin, selection)
    assert.equal(fs.readFileSync(path.join(plugin, 'skills', 'keep', 'SKILL.md'), 'utf8'), '# keep\n| b | [y](references/y.md) |\n')
    assert.throws(() => pluginBundleInputs(write({ path: 'plugin', excludeFiles: ['missing.md'] })), /Excluded bundle file does not exist/)
    assert.throws(() => pluginBundleInputs(write({ path: 'plugin', excludeFiles: ['../x.md'] })), /Invalid plugin composition manifest/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
