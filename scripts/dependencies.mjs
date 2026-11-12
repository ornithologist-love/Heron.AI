import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { excludedPackage, omitExcludedDependencies } from '../packages/common/runtime/src/dsh/distribution.mjs'
import { distributionFileContext, discardDistributionFile } from './distribution-files.mjs'
import { visibleSourceFiles } from './source-inventory.mjs'

const inside = (root, file) => { const name = path.relative(root, file); return !path.isAbsolute(name) && name !== '..' && !name.startsWith('..' + path.sep) }
const relative = (root, file) => path.relative(root, file).split(path.sep).join('/')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const receiptFile = (project, host) => path.join(project, '.cache/dependency-assembly', digest(path.resolve(host)) + '.json')
const json = value => JSON.stringify(value, null, 2) + '\n'
async function read(file) { return JSON.parse(await fs.readFile(file, 'utf8')) }
async function writeChanged(file, bytes) {
  const value = Buffer.from(bytes)
  const previous = await fs.readFile(file).catch(error => { if (error.code !== 'ENOENT') throw error })
  if (previous?.equals(value)) return false
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, value)
  return true
}
async function parallel(items, action) {
  const pending = [...items]
  await Promise.all(Array.from({ length: Math.min(8, pending.length) }, async () => {
    while (pending.length) await action(pending.shift())
  }))
}

async function sourceInventory(source, project, manifest) {
  const context = await distributionFileContext(source, manifest)
  const workspace = inside(path.join(project, 'packages'), source)
    && !path.relative(project, source).split(path.sep).includes('node_modules')
  const firstParty = inside(path.join(project, 'packages/common'), source)
  const admitted = firstParty ? visibleSourceFiles(project) : undefined
  const excluded = new Set(['node_modules', '.git', '.cache', ...(workspace ? ['tests'] : [])])
  const files = {}
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue
      const file = path.join(directory, entry.name), name = relative(source, file)
      const stat = entry.isSymbolicLink() ? await fs.stat(file) : entry
      if (entry.isSymbolicLink() && !inside(project, await fs.realpath(file))) throw Error('Dependency file leaves this checkout: ' + file)
      if (stat.isDirectory()) await walk(file)
      else if (stat.isFile() && name !== 'package.json' && !name.endsWith('.map')
        && (!admitted || admitted.has(path.resolve(file)))
        && name !== 'heron-ai-fork.json' && !discardDistributionFile(name, context))
        files[name === 'lib/heron-ai-fork.json' ? 'heron-ai-fork.json' : name] = digest(await fs.readFile(file))
    }
  }
  await walk(source)
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))
}

async function outputFiles(directory) {
  const files = []
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const file = path.join(current, entry.name)
      if (entry.isSymbolicLink()) throw Error('Runtime dependency output contains a link: ' + file)
      if (entry.isDirectory()) await walk(file)
      else if (entry.isFile()) files.push(relative(directory, file))
    }
  }
  try { await walk(directory) } catch (error) { if (error.code !== 'ENOENT') throw error }
  return files
}

async function installedPackages(modules) {
  const packages = []
  async function walk(directory, scope = false) {
    let entries
    try { entries = await fs.readdir(directory, { withFileTypes: true }) }
    catch (error) { if (error.code === 'ENOENT') return; throw error }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const file = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw Error('Runtime dependency output must not contain linked packages: ' + file)
      if (!entry.isDirectory()) continue
      if (!scope && entry.name.startsWith('@')) await walk(file, true)
      else { packages.push(file); await walk(path.join(file, 'node_modules')) }
    }
  }
  await walk(modules)
  return packages
}

// Resolve the installed workspace graph, then synchronize ordinary payload files.
// Source packages and their node_modules are always read-only.
export async function assembleDependencies(project, product, host) {
  const started = performance.now(), phases = [], changes = []
  let phaseStart = started
  const mark = name => { const now = performance.now(); phases.push([name, now - phaseStart]); phaseStart = now }
  const manifest = await read(path.join(product, 'package.json'))
  const slots = new Map(), queue = [], resolution = new Map(), rootModules = path.join(host, 'node_modules')
  const inventory = new Map()
  function filesFor(entry) {
    if (!inventory.has(entry.source)) inventory.set(entry.source, sourceInventory(entry.source, project, entry.manifest))
    return inventory.get(entry.source)
  }
  async function resolve(from, name) {
    const key = from + '\0' + name
    if (resolution.has(key)) return resolution.get(key)
    for (let directory = from; inside(project, directory); directory = path.dirname(directory)) {
      try { const result = await fs.realpath(path.join(directory, 'node_modules', name)); resolution.set(key, result); return result }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      if (directory === project) break
    }
    resolution.set(key, undefined)
  }
  function existing(from, name) {
    for (let directory = from; inside(host, directory); directory = path.dirname(directory)) {
      const found = slots.get(path.join(directory, 'node_modules', name))
      if (found) return found
      if (directory === host) break
    }
  }
  async function dependency(parent, name, optional) {
    if (excludedPackage(name)) return
    const source = await resolve(parent.source, name)
    if (!source) { if (optional) return; throw Error('Missing production dependency: ' + parent.manifest.name + ' -> ' + name) }
    if (!inside(project, source)) throw Error('Dependency leaves this checkout: ' + name)
    const found = existing(parent.destination, name)
    if (found?.source === source) return found
    const manifest = await read(path.join(source, 'package.json'))
    // Separate pnpm stores can contain the same Zod. Preserve its singleton identity
    // only when manifests and payload bytes match and no dependency context is involved.
    if (found && name === 'zod'
      && ['dependencies', 'optionalDependencies', 'peerDependencies'].every(field => !Object.keys(manifest[field] ?? {}).length)
      && json(found.manifest) === json(manifest)
      && json(await filesFor(found)) === json(await filesFor({ source, manifest }))) return found
    const rootSlot = path.join(rootModules, name)
    const destination = slots.has(rootSlot) ? path.join(parent.destination, 'node_modules', name) : rootSlot
    if (slots.has(destination)) throw Error('Conflicting dependency placement: ' + destination)
    const entry = { source, destination, manifest }
    slots.set(destination, entry); queue.push(entry)
    return entry
  }
  async function dependencies(entry) {
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'])
      for (const name of Object.keys(entry.manifest[field] ?? {}))
        await dependency(entry, name, field !== 'dependencies' || !!entry.manifest.optionalDependencies?.[name])
  }
  const application = { source: product, destination: host, manifest }
  await dependencies(application)
  for (let index = 0; index < queue.length; index++) await dependencies(queue[index])
  mark('resolve-graph')
  if (!inside(host, rootModules) || path.resolve(rootModules) === path.join(project, 'node_modules')) throw Error('Invalid dependency output')
  try { if ((await fs.lstat(rootModules)).isSymbolicLink()) throw Error('Runtime dependency output must not be a link') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  function runtimeManifest(value, destination) {
    const result = structuredClone(value)
    delete result.devDependencies; delete result.workspaces; delete result.overrides
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'])
      for (const [name, version] of Object.entries(result[field] ?? {})) {
        if (excludedPackage(name)) { delete result[field][name]; continue }
        if (version.startsWith('file:') || version.startsWith('workspace:')) {
          const target = existing(destination, name)
          if (!target) throw Error('Local runtime dependency is missing: ' + name)
          result[field][name] = target.manifest.version
        }
      }
    return omitExcludedDependencies(result)
  }
  const policyFiles = ['scripts/dependencies.mjs', 'scripts/distribution-files.mjs', 'scripts/prune-distribution.mjs',
    'packages/common/runtime/src/dsh/distribution.mjs']
  const policy = digest(Buffer.concat(await Promise.all(policyFiles.map(file => fs.readFile(path.join(project, file))))))
  const stampFile = path.join(host, '.heron-ai-assembly.json'), cacheFile = receiptFile(project, host)
  let previous
  try { previous = await read(cacheFile) } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
  await parallel(queue, async entry => {
    entry.runtime = runtimeManifest(entry.manifest, entry.destination)
    entry.manifestBytes = json(entry.runtime)
    entry.files = { ...await filesFor(entry), 'package.json': digest(entry.manifestBytes) }
  })
  mark('fingerprint')
  const fingerprints = queue.map(entry => [relative(host, entry.destination), digest(JSON.stringify([entry.source, entry.files]))])
  const hostManifest = runtimeManifest(manifest, host)
  const stamp = digest(JSON.stringify([fingerprints, hostManifest, policy]))
  const record = { schemaVersion: 2, stamp, policy, packages: {} }
  await fs.mkdir(rootModules, { recursive: true })
  const stale = (await installedPackages(rootModules)).filter(file => !slots.has(file)).sort((a, b) => b.length - a.length)
  for (const directory of stale) {
    if (!inside(rootModules, directory) || directory === rootModules) throw Error('Invalid obsolete dependency output')
    if (queue.some(entry => inside(path.join(directory, 'node_modules'), entry.destination))) {
      for (const file of await outputFiles(directory)) await fs.unlink(path.join(directory, file))
    } else await fs.rm(directory, { recursive: true, force: true })
  }
  mark('remove-obsolete-packages')
  let written = 0, removed = 0, reused = 0
  await parallel(queue, async entry => {
    const key = relative(host, entry.destination), files = {}, copied = []
    const old = previous?.schemaVersion === 2 && previous.policy === policy ? previous.packages[key] : undefined
    for (const name of await outputFiles(entry.destination)) if (!Object.hasOwn(entry.files, name)) {
      const file = path.resolve(entry.destination, name)
      if (!inside(rootModules, file)) throw Error('Invalid obsolete dependency file')
      await fs.unlink(file); removed++
    }
    for (const [name, sourceHash] of Object.entries(entry.files)) {
      const cached = old?.files[name]
      const expected = cached?.source === sourceHash ? cached.output : sourceHash
      const destination = path.resolve(entry.destination, name)
      if (!inside(rootModules, destination) || !inside(entry.destination, destination)) throw Error('Invalid dependency file output')
      const actual = await fs.readFile(destination).then(digest, error => { if (error.code !== 'ENOENT') throw error })
      if (actual !== expected) {
        await fs.mkdir(path.dirname(destination), { recursive: true })
        if (name === 'package.json') await fs.writeFile(destination, entry.manifestBytes)
        else await fs.copyFile(path.join(entry.source, name === 'heron-ai-fork.json' ? 'lib/heron-ai-fork.json' : name), destination)
        copied.push(name); written++
      }
      files[name] = { source: sourceHash, output: actual === expected ? expected : sourceHash }
    }
    record.packages[key] = { source: entry.source, files }
    if (copied.length) changes.push({ name: entry.manifest.name, files: copied })
    else reused++
  })
  // Keep the cache deterministic despite bounded parallel file work.
  record.packages = Object.fromEntries(queue.map(entry => {
    const key = relative(host, entry.destination); return [key, record.packages[key]]
  }))
  mark('sync-files')
  const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages: {} }
  for (const entry of queue) {
    const runtime = entry.runtime
    lock.packages[relative(host, entry.destination)] = { name: runtime.name, version: runtime.version,
      dependencies: runtime.dependencies, optionalDependencies: runtime.optionalDependencies, peerDependencies: runtime.peerDependencies,
      peerDependenciesMeta: runtime.peerDependenciesMeta, engines: runtime.engines, license: runtime.license }
  }
  const runtime = { ...hostManifest, scripts: { start: 'node main.mjs' } }
  lock.packages[''] = { name: runtime.name, version: runtime.version, dependencies: runtime.dependencies, engines: runtime.engines }
  await writeChanged(path.join(host, 'package.json'), json(runtime))
  for (const file of ['package-lock.json', 'node_modules/.package-lock.json']) await writeChanged(path.join(host, file), json(lock))
  await writeChanged(path.join(rootModules, '.heron-ai-dsh-forks.json'), await fs.readFile(path.join(project, '.cache/workspace-build.json')))
  await writeChanged(cacheFile, json(record))
  await writeChanged(stampFile, json({ stamp }))
  mark('write-locks')
  console.log('Production dependencies synchronized: ' + queue.length + ' packages, ' + written + ' files written, ' + removed + ' files and ' + stale.length + ' packages removed, ' + reused + ' packages reused')
  console.log('[assembly-timing] ' + phases.map(([name, ms]) => name + '=' + (ms / 1000).toFixed(2) + 's').join(', '))
  if (process.env.HERON_AI_ASSEMBLY_PROFILE === '1') console.log('[assembly-profile] ' + JSON.stringify({ phases, changes }))
}

/** Remember deliberate product transforms so later synchronization compares final output bytes. */
export async function recordAssemblyTransforms(host, transforms) {
  if (!transforms.size) return
  const file = receiptFile(projectRoot, host)
  let record
  try { record = await read(file) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  if (record.schemaVersion !== 2) return
  for (const [target, bytes] of transforms) {
    const name = relative(host, target)
    const owner = Object.keys(record.packages).find(key => name.startsWith(key + '/') && record.packages[key].files[name.slice(key.length + 1)])
    if (!owner) throw Error('Product transform is outside the assembled file inventory: ' + target)
    record.packages[owner].files[name.slice(owner.length + 1)].output = digest(bytes)
  }
  await writeChanged(file, json(record))
}
