// Anchor: Docs/architecture/extensions.md
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await fs.readFile(path.join(PLUGIN_DIR, 'package.json'), 'utf8'))

async function loadClientFactory({ platform = 'Win32', datasetPlatform = '' } = {}) {
  const source = await fs.readFile(path.join(PLUGIN_DIR, 'client.js'), 'utf8')
  const headNodes = []
  let loaded = null

  const makeNode = (tag) => ({
    tagName: tag.toUpperCase(),
    dataset: {},
    textContent: '',
    rel: '',
    href: '',
    removed: false,
    remove() {
      this.removed = true
      const idx = headNodes.indexOf(this)
      if (idx >= 0) headNodes.splice(idx, 1)
    },
  })

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(entry) {
          loaded = entry
        },
      },
    },
    document: {
      documentElement: {
        dataset: datasetPlatform ? { platform: datasetPlatform } : {},
      },
      head: {
        append(...nodes) {
          headNodes.push(...nodes)
        },
      },
      createElement: makeNode,
    },
    navigator: {
      platform,
      userAgent: platform,
    },
  }

  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(loaded, 'client.js should register via __ModuleLoader__.load')
  assert.equal(loaded.id, manifest.name)
  return {
    plugin: loaded.factory(),
    headNodes,
  }
}

function createMockContext(initialCodeSize = 11) {
  const effects = []
  const listeners = new Map()
  const overrideCalls = []
  let snapshot = {
    fontSizes: { text: 14, code: initialCodeSize, terminal: 13 },
  }
  let activeDisposeCount = 0

  const ctx = {
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') effects.push(cleanup)
      return cleanup
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(handler)
      return () => listeners.get(event)?.delete(handler)
    },
    theme: {
      getTheme() {
        return snapshot
      },
      overrideTokens(source, tokens) {
        overrideCalls.push({ source, tokens })
        // Simulate ThemeRuntime emitting 'theme/change' synchronously on overrideTokens
        for (const handler of listeners.get('theme/change') ?? []) {
          handler(snapshot)
        }
        let disposed = false
        return () => {
          if (!disposed) {
            disposed = true
            activeDisposeCount += 1
          }
        }
      },
    },
  }

  const setCodeSize = (px) => {
    snapshot = { fontSizes: { text: 14, code: px, terminal: 13 } }
    for (const handler of listeners.get('theme/change') ?? []) {
      handler(snapshot)
    }
  }

  const disposeAll = () => {
    while (effects.length > 0) {
      effects.pop()()
    }
  }

  return { ctx, overrideCalls, setCodeSize, disposeAll, getDisposeCount: () => activeDisposeCount }
}

test('the bundle patch and client register with the manifest identity', async () => {
  const patch = await fs.readFile(path.join(PLUGIN_DIR, 'cordis.patch.yml'), 'utf8')

  assert.equal(manifest.dsh?.manifestVersion, 1)
  assert.match(patch, new RegExp(`id:\\s*${manifest.name}\\b`))
  assert.match(patch, new RegExp(`name:\\s*${manifest.name}\\b`))
  await loadClientFactory()
})

test('the theme uses a same-origin stylesheet and withdraws its overrides on disposal', async () => {
  const { plugin, headNodes } = await loadClientFactory()
  assert.deepEqual(Array.from(plugin.inject), ['theme'])

  const { ctx, overrideCalls, setCodeSize, disposeAll, getDisposeCount } = createMockContext(11)
  plugin.apply(ctx)

  const link = headNodes.find((n) => n.tagName === 'LINK')
  const style = headNodes.find((n) => n.tagName === 'STYLE')
  assert.ok(link, 'should append the font stylesheet')
  assert.equal(new URL(link.href, 'https://theme.example.invalid/').origin, 'https://theme.example.invalid')

  assert.ok(style, 'should append theme style tag')

  assert.equal(overrideCalls.length, 1, 're-entrant theme/change must not loop overrideTokens')
  assert.ok(overrideCalls[0].tokens['--dsh-code-font-size'])

  // Customizing code font size away from 11px drops the override
  setCodeSize(13)
  assert.equal(overrideCalls.length, 2)
  assert.equal(overrideCalls[1].tokens['--dsh-code-font-size'], undefined)

  // Disposal removes DOM nodes and clears token override layer
  disposeAll()
  assert.equal(headNodes.length, 0)
  assert.equal(link.removed, true)
  assert.equal(style.removed, true)
  assert.equal(getDisposeCount(), 1)
})
