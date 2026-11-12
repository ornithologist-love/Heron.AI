import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire, registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { enabledProductPackages, productProfile, readContent } from './product-profile.mjs'
import { bundleFileIncluded } from './package-files.mjs'

const host = fileURLToPath(new URL('../', import.meta.url))
const runtimeParent = pathToFileURL(path.join(host, 'package.json')).href
const roots = new Set()
const modules = new Map()
registerHooks({ resolve(specifier, context, next) {
  if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes(':')
      && [...roots].some(root => context.parentURL?.startsWith(root))) {
    try { createRequire(runtimeParent).resolve(specifier); return next(specifier, { ...context, parentURL: runtimeParent }) }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_MODULE_NOT_FOUND') throw error }
  }
  return next(specifier, context)
} })

export async function productIntegrations() {
  const result = []
  for (const [id, { root, manifest }] of enabledProductPackages) {
    const relative = manifest.heronAi?.integration
    if (relative === undefined) continue
    if (typeof relative !== 'string') throw Error('Invalid integration entry: ' + id)
    const file = path.resolve(root, relative), below = path.relative(root, file)
    if (!below || below.startsWith('..') || path.isAbsolute(below)) throw Error('Integration entry must stay inside its package')
    roots.add(pathToFileURL(root + path.sep).href)
    if (!modules.has(file)) modules.set(file, import(pathToFileURL(file).href))
    result.push({ id, root, manifest, module: await modules.get(file) })
  }
  return result
}

export async function prepareIntegrationOptions(options) {
  for (const { module } of await productIntegrations()) await module.prepareOptions?.(options, { productProfile, readContent })
}

export async function prepareIntegrationRequest(request) {
  for (const { module } of await productIntegrations()) await module.prepareAutomationRequest?.(request)
}

export async function integrationConfigurationKey(options) {
  const values = []
  for (const { id, module } of await productIntegrations())
    if (module.compositionKey) values.push({ id, value: await module.compositionKey(options) })
  return values
}

export async function composeIntegrations(options) {
  const merged = { rows: [], brands: [], providerNotices: [], providerSignIn: {}, clientPackages: [], skillGroupLabels: [] }
  for (const { root, module } of await productIntegrations()) {
    const value = await module.compose?.(options) ?? {}
    for (const key of ['rows', 'brands', 'providerNotices', 'skillGroupLabels']) merged[key].push(...value[key] ?? [])
    for (const directory of value.clientPackages ?? []) {
      const file = path.resolve(directory), below = path.relative(root, file)
      if (below.startsWith('..') || path.isAbsolute(below)) throw Error('Client package must stay inside its integration')
      merged.clientPackages.push(file)
    }
    Object.assign(merged.providerSignIn, value.providerSignIn)
    for (const key of ['credentialPolicy']) {
      if (value[key] === undefined) continue
      if (merged[key] !== undefined) throw Error('Conflicting integration contribution: ' + key)
      merged[key] = value[key]
    }
  }
  return merged
}

// Composition includes private channel UI and images. Their contents must
// participate in the key even though they live outside the public runtime.
export async function integrationFingerprint() {
  const hash = createHash('sha256')
  for (const { id, root, manifest } of await productIntegrations()) {
    hash.update(id).update(root)
    async function walk(directory) {
      for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        const file = path.join(directory, entry.name)
        if (!bundleFileIncluded(manifest, path.relative(root, file), entry.isDirectory())) continue
        if (entry.isDirectory()) await walk(file)
        else if (entry.isFile()) hash.update(path.relative(root, file)).update(await fs.readFile(file))
      }
    }
    await walk(root)
  }
  return hash.digest('hex')
}
