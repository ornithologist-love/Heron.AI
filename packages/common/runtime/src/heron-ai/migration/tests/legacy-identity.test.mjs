// Anchor: Docs/architecture/identity-migration.md#旧身份由分发方声明
// The runtime knows no former name: only a shipped package descriptor drives migration, and it stays confined.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { emptyLegacyIdentity, loadShippedLegacyIdentity, mergeLegacyIdentities, parseLegacyIdentity, renameIdentifier }
  from '../legacy-identity.mjs'
import { prepareStateDirectory } from '../branding.mjs'

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'heron-legacy-'))
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}
const descriptor = {
  version: 1, stateDirectories: ['.old-product'], chatDirectories: ['.old-chats'],
  identifiers: { 'old-theme': 'heron-ai-theme', 'old-acp-special': 'heron-ai-special' },
  prefixes: [['old-acp-', 'heron-ai-acp-'], ['OLD_', 'HERON_AI_']],
}

function payload(manifestExtra, files = { 'legacy.json': descriptor }) {
  const root = temp()
  write(path.join(root, 'package.json'), { name: 'host' })
  const pkg = path.join(root, 'node_modules', 'distributor')
  write(path.join(pkg, 'package.json'), { name: 'distributor', heronAi: { legacyIdentity: './legacy.json', ...manifestExtra } })
  for (const [name, value] of Object.entries(files)) write(path.join(pkg, name), value)
  return root
}

test('shipped descriptor drives identifier renames, exact entries before prefixes', () => {
  const identity = loadShippedLegacyIdentity({ shipped: ['distributor'], resolveFrom: payload() })
  assert.equal(renameIdentifier('old-theme', identity), 'heron-ai-theme')
  assert.equal(renameIdentifier('old-acp-special', identity), 'heron-ai-special')
  assert.equal(renameIdentifier('old-acp-default', identity), 'heron-ai-acp-default')
  assert.equal(renameIdentifier('OLD_TOKEN', identity), 'HERON_AI_TOKEN')
  assert.equal(renameIdentifier('unrelated', identity), 'unrelated')
})

test('without a descriptor nothing is renamed and the home directory is left alone', async () => {
  const home = temp()
  fs.mkdirSync(path.join(home, '.old-product'))
  const identity = loadShippedLegacyIdentity({ shipped: ['missing-package'], resolveFrom: payload() })
  assert.equal(identity, emptyLegacyIdentity)
  assert.equal(renameIdentifier('old-theme', identity), 'old-theme')
  assert.equal(await prepareStateDirectory({ home, identity }), path.join(home, '.heron-ai'))
  assert.ok(fs.existsSync(path.join(home, '.old-product')))
  assert.ok(!fs.existsSync(path.join(home, '.heron-ai')))
})

test('declared former state and chats move into the new state directory', async () => {
  const home = temp()
  write(path.join(home, '.old-product', 'settings.yaml'), 'a: 1\n')
  write(path.join(home, '.old-chats', 'chats', 'one.jsonl'), 'old')
  const identity = loadShippedLegacyIdentity({ shipped: ['distributor'], resolveFrom: payload() })
  const target = await prepareStateDirectory({ home, identity })
  assert.equal(fs.readFileSync(path.join(target, 'settings.yaml'), 'utf8'), 'a: 1\n')
  assert.equal(fs.readFileSync(path.join(target, 'chats', 'one.jsonl'), 'utf8'), 'old')
  assert.ok(!fs.existsSync(path.join(home, '.old-product')))
})

test('a descriptor outside its package or with unsafe values is rejected', () => {
  const outside = payload({ legacyIdentity: '../escape.json' })
  write(path.join(outside, 'node_modules', 'escape.json'), descriptor)
  assert.throws(() => loadShippedLegacyIdentity({ shipped: ['distributor'], resolveFrom: outside }), /inside its package/)
  for (const bad of [{ ...descriptor, version: 2 }, { ...descriptor, extra: 1 }, { version: 1, stateDirectories: ['../home'] },
    { version: 1, stateRenames: [['a', '../b']] }, { version: 1, identifiers: { a: 'b\nc' } }])
    assert.throws(() => parseLegacyIdentity(bad), /Invalid legacy identity/)
})

test('two packages may not map one former identifier differently', () => {
  const one = parseLegacyIdentity({ version: 1, identifiers: { x: 'a' } })
  const two = parseLegacyIdentity({ version: 1, identifiers: { x: 'b' } })
  assert.throws(() => mergeLegacyIdentities([one, two]), /Conflicting legacy identifier/)
})
