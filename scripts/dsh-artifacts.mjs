// Consume the pinned official npm artifacts. This module never invokes a compiler.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dshPatchState } from './dsh-patches.mjs'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const generatedRoots = new Set(['lib', 'dist', 'bin'])
const read = file => fs.readFile(file, 'utf8').then(JSON.parse)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const git = (directory, args) => execFileSync('git', ['-C', directory, ...args], {
  encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
}).trim()
const within = (parent, file) => {
  const relative = path.relative(parent, file)
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}
async function parallel(items, action) {
  const pending = [...items]
  await Promise.all(Array.from({ length: Math.min(8, pending.length) }, async () => {
    while (pending.length) await action(pending.shift())
  }))
}
async function list(directory, prefix = '') {
  const result = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = prefix + entry.name
    if (entry.isSymbolicLink()) throw Error('DSH artifact contains a link: ' + file)
    if (entry.isDirectory()) result.push(...await list(path.join(directory, entry.name), file + '/'))
    else if (entry.isFile()) result.push(file)
  }
  return result.sort()
}
async function fetchBytes(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) })
  if (!response.ok) throw Error(`Official DSH download failed (${response.status}): ${url}`)
  return Buffer.from(await response.arrayBuffer())
}
async function identity(root) {
  const source = (await read(path.join(root, 'config/upstreams.json'))).sources.dsh
  const repository = path.resolve(root, source.directory)
  return { repository, commit: source.upstreamCommit, version: (await read(path.join(repository, 'package.json'))).version }
}

async function officialPackage(entry, cache) {
  const key = digest(entry.integrity)
  const directory = path.join(cache, key)
  const receiptFile = path.join(directory, 'receipt.json')
  try {
    const receipt = await read(receiptFile)
    if (receipt.name === entry.name && receipt.version === entry.version && receipt.integrity === entry.integrity)
      return { directory, receipt }
  } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code) && !(error instanceof SyntaxError)) throw error }
  await fs.mkdir(cache, { recursive: true })
  const archive = path.join(cache, key + '.tgz')
  let bytes = await fs.readFile(archive).catch(error => { if (error.code !== 'ENOENT') throw error })
  if (!bytes || 'sha512-' + createHash('sha512').update(bytes).digest('base64') !== entry.integrity) {
    bytes = await fetchBytes(entry.tarball)
    if ('sha512-' + createHash('sha512').update(bytes).digest('base64') !== entry.integrity)
      throw Error('Official DSH archive integrity mismatch: ' + entry.name)
    await fs.writeFile(archive, bytes)
  }
  const tar = args => execFileSync('tar', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  for (const name of tar(['-tzf', archive]).trim().split(/\r?\n/)) {
    if (!name.startsWith('package/') || name.includes('\\') || name.split('/').includes('..'))
      throw Error('Invalid official DSH archive path: ' + name)
  }
  const pending = directory + '.pending-' + process.pid
  if (!within(cache, pending) || !within(cache, directory)) throw Error('Invalid DSH artifact cache path')
  await fs.rm(pending, { recursive: true, force: true })
  await fs.mkdir(pending, { recursive: true })
  try {
    tar(['-xzf', archive, '-C', pending])
    const unpacked = path.join(pending, 'package')
    const manifest = await read(path.join(unpacked, 'package.json'))
    if (manifest.name !== entry.name || manifest.version !== entry.version)
      throw Error('Official DSH package identity mismatch: ' + entry.name)
    const files = Object.fromEntries(await Promise.all((await list(unpacked))
      .filter(file => generatedRoots.has(file.split('/')[0]))
      .map(async file => [file, digest(await fs.readFile(path.join(unpacked, file)))])))
    const receipt = { name: entry.name, version: entry.version, integrity: entry.integrity, files }
    await fs.writeFile(path.join(pending, 'receipt.json'), JSON.stringify(receipt) + '\n')
    await fs.rm(directory, { recursive: true, force: true })
    await fs.rename(pending, directory)
    return { directory, receipt }
  } catch (error) {
    await fs.rm(pending, { recursive: true, force: true })
    throw error
  }
}

/** Materialize only generated directories, leaving upstream source and installed dependencies intact. */
export async function prepareDshArtifacts(root = project) {
  const started = performance.now()
  const source = await identity(root)
  const lock = await read(path.join(root, 'config/dsh-artifacts.lock.json'))
  if (lock.schemaVersion !== 1 || lock.source.commit !== source.commit || lock.source.version !== source.version)
    throw Error('Official DSH artifact lock is stale; run npm run dsh:lock for the adopted source version')
  // Seam-patched packages are compiled from source by scripts/dsh-build.
  const { patched, shell } = await dshPatchState(root, lock)
  const skipped = new Set([...patched, ...shell ? [shell] : []].map(entry => entry.directory))
  const tracked = new Set(git(source.repository, ['ls-files']).split(/\r?\n/))
  const cache = path.join(root, '.cache/dsh-artifacts')
  let restored = 0
  await parallel(lock.packages.filter(entry => !skipped.has(entry.directory)), async entry => {
    const target = path.resolve(source.repository, entry.directory)
    if (!within(source.repository, target) || target === source.repository) throw Error('Invalid DSH package directory')
    const manifest = await read(path.join(target, 'package.json'))
    if (manifest.name !== entry.name || manifest.version !== entry.version) throw Error('DSH source/package version mismatch: ' + entry.name)
    const { directory, receipt } = await officialPackage(entry, cache)
    const roots = [...new Set(Object.keys(receipt.files).map(file => file.split('/')[0]))]
    if (roots.some(name => !generatedRoots.has(name))) throw Error('Invalid DSH artifact output')
    let intact = true
    for (const name of roots) {
      const output = path.join(target, name)
      const expected = Object.keys(receipt.files).filter(file => file.startsWith(name + '/')).sort()
      try {
        const actual = (await list(output)).map(file => name + '/' + file)
        if (JSON.stringify(actual) !== JSON.stringify(expected)) { intact = false; break }
        for (const file of expected) if (digest(await fs.readFile(path.join(target, file))) !== receipt.files[file]) { intact = false; break }
      } catch (error) { if (error.code === 'ENOENT') intact = false; else throw error }
      if (!intact) break
    }
    if (intact) return
    for (const name of roots) {
      const relative = entry.directory + '/' + name + '/'
      if ([...tracked].some(file => file.startsWith(relative))) throw Error('DSH artifact would overwrite tracked source: ' + relative)
      const output = path.resolve(target, name)
      if (!within(source.repository, output) || !within(target, output)) throw Error('Invalid DSH output directory')
      // These directories contain generated outputs only. Never replace manifests,
      // sources, the workspace node_modules, or another task's tracked files.
      await fs.rm(output, { recursive: true, force: true })
      await fs.cp(path.join(directory, 'package', name), output, { recursive: true })
    }
    restored++
  })
  console.log(`[dsh-artifacts] Official ${source.version}: ${lock.packages.length - skipped.size} packages verified, ${restored} restored; ${skipped.size} seam-patched packages built by dsh-build (${((performance.now() - started) / 1000).toFixed(2)}s)`)
}

async function updateLock(root) {
  const source = await identity(root)
  const packages = []
  const manifests = git(source.repository, ['ls-files', '**/package.json']).split(/\r?\n/)
    .filter(file => /^(vendor\/[^/]+|packages\/[^/]+\/[^/]+|apps\/[^/]+|native\/system\/packages\/[^/]+)\/package.json$/.test(file))
  await parallel(manifests, async file => {
    const manifest = await read(path.join(source.repository, file))
    if (manifest.private || !manifest.name?.startsWith('@deepseek-ai/')) return
    const metadata = JSON.parse((await fetchBytes(`https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${manifest.version}`)).toString())
    packages.push({ directory: path.posix.dirname(file), name: manifest.name, version: manifest.version,
      tarball: metadata.dist.tarball, integrity: metadata.dist.integrity,
      ...(manifest.os ? { os: manifest.os } : {}), ...(manifest.cpu ? { cpu: manifest.cpu } : {}) })
  })
  packages.sort((a, b) => a.directory.localeCompare(b.directory))
  await fs.writeFile(path.join(root, 'config/dsh-artifacts.lock.json'), JSON.stringify({ schemaVersion: 1,
    source: { commit: source.commit, version: source.version, registry: 'https://registry.npmjs.org' }, packages }, null, 2) + '\n')
  console.log(`[dsh-artifacts] Locked ${packages.length} official packages; review and commit config/dsh-artifacts.lock.json`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 2) await prepareDshArtifacts()
  else if (process.argv.length === 3 && process.argv[2] === '--update-lock') await updateLock(project)
  else throw Error('Usage: dsh-artifacts.mjs [--update-lock]')
}
