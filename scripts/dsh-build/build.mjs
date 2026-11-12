// Compile product and community plugins against the unmodified official DSH.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { FaceModelEmitter, WorkspaceTypertGenerator, writePackageArtifacts } from '@deepseek-ai/dsh-typert-generator'
import { analyzeProduct } from './typert.mjs'
import { dshPatchState } from '../dsh-patches.mjs'

const tools = path.dirname(fileURLToPath(import.meta.url))
const project = path.resolve(tools, '../..')
const dsh = path.join(project, 'packages/dsh')
const require = createRequire(import.meta.url)
const ts = require('typescript')
// The DSH configs return native bundler objects, which must share the compiler's module instance.
const { build } = await import(pathToFileURL(createRequire(path.join(dsh, 'package.json')).resolve('tsdown')).href)
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--package')) throw Error('Usage: build.mjs [--package <workspace>]')
const read = file => fs.readFile(file, 'utf8').then(JSON.parse)
const rosterFile = path.join(tools, 'forks.json')
const sourcesFile = path.join(project, 'config/upstreams.json')
const forks = await read(rosterFile)
const expected = await read(path.join(project, 'packages/common/runtime/src/dsh/forks.json'))
if (JSON.stringify(forks) !== JSON.stringify(expected)) throw Error('Product and DSH workspace rosters differ')
const sources = await read(sourcesFile)
// DSH is the pinned official commit, optionally with seam commits on top.
const lock = await read(path.join(project, 'config/dsh-artifacts.lock.json'))
const { patched, shell } = await dshPatchState(project, lock)
const dshVersion = (await read(path.join(dsh, 'package.json'))).version
const dshBase = ts.readConfigFile(path.join(dsh, 'tsconfig.base.json'), ts.sys.readFile)
if (dshBase.error) throw Error(ts.flattenDiagnosticMessageText(dshBase.error.messageText, '\n'))
// Vendored package directories by name; their manifests point type resolution at the built lib/types.
const vendorPackages = Object.fromEntries(Object.entries(dshBase.config.compilerOptions?.paths ?? {})
  .filter(([, targets]) => targets.length === 1 && /^\.\/vendor\/[^/]+\/src$/.test(targets[0]))
  .map(([name, [target]]) => [name, path.join(dsh, path.dirname(target))]))
async function installedFrom(directory, name) {
  for (let current = directory; current.startsWith(project); current = path.dirname(current))
    if (await fs.access(path.join(current, 'node_modules', name)).then(() => true, () => false)) return true
  return false
}
const digest = file => fs.readFile(file).then(bytes => createHash('sha256').update(bytes).digest('hex'))
async function files(directory) {
  const result = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await files(file))
    else if (entry.isFile()) result.push(file)
  }
  return result.sort()
}
// Seam-patched official packages replace their npm artifact in place: tsc emits
// lib/types against the official declarations, tsdown bundles the runtime
// entries, and Typert regenerates remote faces, as the official host build does.
// Patched packages compile against each other's fresh declarations, so dependencies build first.
const patchedOrder = []
{
  const manifests = new Map(await Promise.all(patched.map(async entry => [entry, await read(path.join(dsh, entry.directory, 'package.json'))])))
  const byName = new Map([...manifests].map(([entry, manifest]) => [manifest.name, entry]))
  const sourceImports = new Map(await Promise.all(patched.map(async entry => {
    const names = new Set()
    for (const file of (await files(path.join(dsh, entry.directory, 'src'))).filter(file => /\.(ts|tsx)$/.test(file)))
      for (const imported of ts.preProcessFile(await fs.readFile(file, 'utf8'), true, true).importedFiles)
        names.add(imported.fileName.startsWith('@') ? imported.fileName.split('/').slice(0, 2).join('/') : imported.fileName.split('/')[0])
    return [entry, names]
  })))
  const edges = (entry, keys) => {
    const manifest = manifests.get(entry)
    // Manifest devDependencies also describe activation/test relationships. They
    // can point back without a source import (sidebar -> workspace), creating a
    // false cycle that used to drop the real workspace -> sidebar type edge.
    return keys.flatMap(key => Object.keys(manifest[key] ?? {})
      .filter(name => key !== 'devDependencies' || sourceImports.get(entry).has(name)))
      .map(name => byName.get(name)).filter(next => next && next !== entry)
  }
  const reaches = (from, to, seen = new Set()) => from === to || (!seen.has(from) && seen.add(from)
    && edges(from, ['dependencies', 'peerDependencies', 'devDependencies']).some(next => reaches(next, to, seen)))
  const visit = (entry, trail = new Set()) => {
    if (patchedOrder.includes(entry)) return
    if (trail.has(entry)) throw Error('Seam-patched package cycle: ' + manifests.get(entry).name)
    trail.add(entry)
    for (const next of edges(entry, ['dependencies', 'peerDependencies'])) visit(next, trail)
    // Client static libraries are devDependencies; a test-only devDependency that
    // points back (sandbox-windows-acl tests boot sandbox-local) orders nothing.
    // Test-support packages exist only for specs, so a devDependency on one orders nothing.
    for (const next of edges(entry, ['devDependencies']))
      if (!next.directory.startsWith('packages/test-support/') && !reaches(next, entry)) visit(next, trail)
    trail.delete(entry)
    patchedOrder.push(entry)
  }
  for (const entry of patched) visit(entry)
}
// Source hashes of already-built patched packages by name; a dependent folds in
// the hashes of the patched packages it declares, since it may bundle their output.
const patchedHashes = new Map()
for (const entry of patchedOrder) {
  const directory = path.join(dsh, entry.directory)
  const manifest = await read(path.join(directory, 'package.json'))
  const cacheDirectory = path.join(project, '.cache', 'dsh-build', 'patched')
  const name = manifest.name.replace('@deepseek-ai/', '')
  await fs.mkdir(cacheDirectory, { recursive: true })
  // Solution-only roots compile nothing, so split host/client compiler faces each compile with their own leaf config.
  const split = await Promise.all(['tsconfig.host.json', 'tsconfig.client.json']
    .map(file => fs.access(path.join(directory, file)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })))
  const compileFaces = split.every(Boolean)
    ? [{ name: 'host', file: 'tsconfig.host.json' }, { name: 'client', file: 'tsconfig.client.json' }]
    : [{ name: undefined, file: 'tsconfig.json' }]
  // Each face keeps its own ambient types (Client faces have no node types).
  const faceTypes = file => {
    const loaded = ts.readConfigFile(file, ts.sys.readFile)
    if (loaded.error) throw Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'))
    return ts.parseJsonConfigFileContent({ ...loaded.config, files: [], include: [], references: [] }, ts.sys, path.dirname(file), undefined, file).options.types ?? ['node']
  }
  // DSH resolves vendored packages through tsconfig paths; a patched package importing one it does not
  // declare (type-only, e.g. cordis-plugin-include) finds no installed copy, so it maps to the vendor package.
  const selfPaths = {}
  for (const [name, vendor] of Object.entries(vendorPackages))
    if (!await installedFrom(directory, name)) selfPaths[name] = [vendor]
  // Self-imports of exports compiled from src resolve to src, not to another face's emitted lib/types.
  for (const [key, target] of Object.entries(manifest.exports ?? {})) {
    const types = typeof target === 'object' ? target.types : undefined
    if (key === '.' || typeof types !== 'string' || !types.startsWith('./lib/types/')) continue
    const source = path.join(directory, 'src', types.slice('./lib/types/'.length).replace(/\.d\.ts$/, '.ts'))
    if (await fs.access(source).then(() => true, () => false)) selfPaths[manifest.name + key.slice(1)] = [source]
  }
  const tsconfigs = compileFaces.map(face => ({ ...face,
    config: path.join(cacheDirectory, name + (face.name ? '.' + face.name : '') + '.json'),
    tsconfig: JSON.stringify({ extends: path.join(directory, face.file), compilerOptions: {
      paths: selfPaths, preserveSymlinks: false, composite: false, incremental: false, declarationMap: false, sourceMap: false,
      typeRoots: [path.join(dsh, 'scripts/types'), path.join(project, 'node_modules/@types')], types: faceTypes(path.join(directory, face.file)),
    }, references: [] }, null, 2) }))
  const hash = createHash('sha256')
  for (const { tsconfig } of tsconfigs) hash.update(tsconfig)
  const clientInputs = manifest.dsh?.client
    ? [path.join(directory, 'tsdown.config.ts'), path.join(dsh, 'packages/client/tsdown.client.ts')] : []
  // Host packages with their own tsdown config bundle every declared entry, including CJS workers.
  const hostTsdown = !clientInputs.length && await fs.access(path.join(directory, 'tsdown.config.ts'))
    .then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
  const hostInputs = hostTsdown ? [path.join(directory, 'tsdown.config.ts')] : []
  for (const file of [...await files(path.join(directory, 'src')), path.join(directory, 'package.json'),
    ...compileFaces.map(face => path.join(directory, face.file)), ...clientInputs, ...hostInputs,
    path.join(tools, 'build.mjs'), path.join(tools, 'typert.mjs'), path.join(project, 'pnpm-lock.yaml'), path.join(project, 'config/dsh-artifacts.lock.json')])
    hash.update(path.relative(dsh, file)).update('\0').update(await fs.readFile(file)).update('\0')
  for (const section of ['dependencies', 'peerDependencies', 'devDependencies'])
    for (const dependency of Object.keys(manifest[section] ?? {}).sort())
      if (patchedHashes.has(dependency)) hash.update(dependency).update('\0').update(patchedHashes.get(dependency)).update('\0')
  const sourceHash = hash.digest('hex')
  patchedHashes.set(manifest.name, sourceHash)
  const recordFile = path.join(cacheDirectory, name + '.record.json')
  const outputs = Object.values(manifest.exports ?? {}).map(target => typeof target === 'string' ? target : target.default)
    .filter(target => /^\.\/lib\/[^/]+\.c?js$/.test(target ?? '')).map(target => target.slice('./lib/'.length))
  const outputHashes = () => Promise.all(outputs.map(async name => [name, await digest(path.join(directory, 'lib', name))])).then(Object.fromEntries)
  let cached
  try { cached = await read(recordFile) } catch (error) { if (error.code !== 'ENOENT') throw error }
  let intact = false
  if (cached?.sourceHash === sourceHash) {
    try { intact = JSON.stringify(await outputHashes()) === JSON.stringify(cached.outputs) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if (!intact) {
    for (const face of tsconfigs) await fs.writeFile(face.config, face.tsconfig)
    await fs.rm(path.join(directory, 'lib'), { recursive: true, force: true })
    // The official build analyzes every Host contributor in one program, so
    // declaration merges from other packages reach this package's model.
    const generateTypert = () => {
      for (const artifact of new WorkspaceTypertGenerator(dsh, { checkDiagnostics: false }).generate([manifest.name], ['host']))
        writePackageArtifacts(path.join(dsh, artifact.packageRoot), [artifact])
    }
    for (const face of tsconfigs) {
      // A Client face may import this package's own generated Remote face, so it follows the Host face's Typert.
      if (face.name === 'client' && manifest.exports?.['./typert']) generateTypert()
      const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', face.config], { cwd: dsh, stdio: 'inherit', windowsHide: true })
      if (result.error) throw result.error
      if (result.status !== 0) throw Error('Seam-patched package compilation failed: ' + manifest.name)
    }
    if (manifest.dsh?.client) {
      // Client packages bundle through their own tsdown.config.ts, both build faces in order,
      // with the public environment the official release embedded (its commit is the
      // release build's, recorded in the restored official modules artifact).
      const release = /const commit = "([0-9a-f]{7,40})"/.exec(await fs.readFile(path.join(dsh, 'packages/client/modules/lib/index.js'), 'utf8'))
      if (!release) throw Error('Official DSH release commit not found in @deepseek-ai/dsh-client-modules')
      const saved = { ...process.env }
      Object.assign(process.env, { DSH_CLIENT_BUILD_PROFILE: 'official', DSH_CLIENT_TITLE: 'Heron.AI',
        DSH_CLIENT_VERSION: dshVersion, DSH_CLIENT_COMMIT_HASH: release[1] })
      try {
        const { default: faces } = await import(pathToFileURL(path.join(directory, 'tsdown.config.ts')).href)
        for (const phase of ['host', 'client'])
          for (const face of faces({ env: { DSH_BUILD_FACE: phase } }).filter(face => face.entry !== ''))
            await build({ ...face, config: false, cwd: directory,
              tsconfig: (tsconfigs.find(config => config.name === phase) ?? tsconfigs.find(config => config.name === 'host') ?? tsconfigs[0]).config })
      } finally {
        for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]
        Object.assign(process.env, saved)
      }
    } else if (hostTsdown) {
      // Build-face functions (static libraries) select their configs per face, as the official two-pass build does.
      const { default: configs } = await import(pathToFileURL(path.join(directory, 'tsdown.config.ts')).href)
      const selected = typeof configs === 'function'
        ? ['host', 'client'].flatMap(phase => configs({ env: { DSH_BUILD_FACE: phase } })) : [configs].flat()
      for (const options of selected.filter(options => options.entry !== '')) await build({ ...options, config: false, cwd: directory })
    } else {
      const bundles = outputs.filter(name => !name.startsWith('typert.') && name.endsWith('.js'))
      const dependencies = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]
      for (const name of bundles) await build({ entry: ['lib/types/' + name], outDir: 'lib', format: 'esm', platform: 'node',
        target: 'es2024', fixedExtension: false, dts: false, clean: false,
        deps: { neverBundle: [/^@deepseek-ai\//, ...dependencies] }, config: false, cwd: directory })
    }
    // Published packages carry only bundles and declarations, not tsc's JavaScript or bundle maps,
    // except tsc output an export names directly.
    const exported = new Set(Object.values(manifest.exports ?? {}).flatMap(target => typeof target === 'string' ? [target] : Object.values(target))
      .filter(target => typeof target === 'string').map(target => path.join(directory, target)))
    // An exported tsc module keeps the tsc modules it imports relatively (e.g. tool-cordis ./host).
    for (const file of exported) {
      if (!file.endsWith('.js') || !await fs.access(file).then(() => true, () => false)) continue
      for (const [, specifier] of (await fs.readFile(file, 'utf8')).matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+\.js)['"]/g))
        exported.add(path.resolve(path.dirname(file), specifier))
    }
    for (const file of await files(path.join(directory, 'lib')))
      if (!exported.has(file) && (/\.js$/.test(file) && file.startsWith(path.join(directory, 'lib', 'types') + path.sep) || /\.js\.map$/.test(file))) await fs.rm(file)
    if (manifest.exports?.['./typert']) generateTypert()
    await fs.writeFile(recordFile, JSON.stringify({ name: manifest.name, sourceHash, outputs: await outputHashes() }, null, 2) + '\n')
  }
  console.log(`Seam-patched package ${intact ? 'cached' : 'built'}: ${manifest.name} ${sourceHash.slice(0, 12)}`)
}
// Static libraries are linked into the Web shell, so a seam in one rebuilds
// apps/web with its own Vite and the official public environment.
if (shell) {
  const started = performance.now()
  const directory = path.join(dsh, shell.directory)
  const cacheDirectory = path.join(project, '.cache', 'dsh-build', 'patched')
  const recordFile = path.join(cacheDirectory, 'web.record.json')
  const inputReport = path.join(cacheDirectory, 'web.inputs.json')
  const runner = path.join(tools, 'web-build.mjs')
  const release = /const commit = "([0-9a-f]{7,40})"/.exec(await fs.readFile(path.join(dsh, 'packages/client/modules/lib/index.js'), 'utf8'))
  if (!release) throw Error('Official DSH release commit not found in @deepseek-ai/dsh-client-modules')
  const environment = { DSH_CLIENT_BUILD_PROFILE: 'official', DSH_CLIENT_TITLE: 'Heron.AI',
    DSH_CLIENT_VERSION: dshVersion, DSH_CLIENT_COMMIT_HASH: release[1] }
  const inputs = [...await files(path.join(directory, 'src')), ...await files(path.join(directory, 'public')),
    path.join(tools, 'build.mjs'), runner, path.join(project, 'pnpm-lock.yaml'), path.join(project, 'config/dsh-artifacts.lock.json'),
    // This license is emitted by the Vite config through fs.readFile, outside Rollup's watched graph.
    path.join(dsh, 'packages/client/ui-theme/src/styles/Montserrat-OFL.txt'),
    ...(await fs.readdir(directory)).filter(file => /\.(json|ts|html)$/.test(file)).map(file => path.join(directory, file))]
  async function inputHash(dependencies) {
    const hash = createHash('sha256').update(JSON.stringify(environment))
    for (const file of [...new Set([...inputs, ...dependencies.map(file => path.resolve(dsh, file))])].sort())
      hash.update(path.relative(dsh, file)).update('\0').update(await fs.readFile(file)).update('\0')
    return hash.digest('hex')
  }
  const outputHashes = async () => Object.fromEntries(await Promise.all((await files(path.join(directory, 'dist')))
    .map(async file => [path.relative(directory, file), await digest(file)])))
  let cached
  try { cached = await read(recordFile) } catch (error) { if (error.code !== 'ENOENT') throw error }
  let sourceHash
  if (Array.isArray(cached?.inputs)) {
    try { sourceHash = await inputHash(cached.inputs) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  let intact = false
  if (sourceHash && cached.sourceHash === sourceHash) {
    try { intact = JSON.stringify(await outputHashes()) === JSON.stringify(cached.outputs) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if (!intact) {
    await fs.mkdir(cacheDirectory, { recursive: true })
    await fs.rm(path.join(directory, 'dist'), { recursive: true, force: true })
    const result = spawnSync(process.execPath, [runner, directory, inputReport], {
      cwd: directory, stdio: 'inherit', windowsHide: true, env: { ...process.env, ...environment } })
    if (result.error) throw result.error
    if (result.status !== 0) throw Error('Web shell build failed: ' + shell.name)
    // The published shell carries neither source maps nor the component preview page.
    await fs.rm(path.join(directory, 'dist/preview.html'), { force: true })
    await fs.rm(path.join(directory, 'dist/preview'), { recursive: true, force: true })
    for (const file of await files(path.join(directory, 'dist'))) if (file.endsWith('.map')) await fs.rm(file)
    const dependencies = (await read(inputReport)).map(file => path.relative(dsh, file).replaceAll('\\', '/'))
    sourceHash = await inputHash(dependencies)
    await fs.writeFile(recordFile, JSON.stringify({ name: shell.name, sourceHash, inputs: dependencies, outputs: await outputHashes() }, null, 2) + '\n')
  }
  console.log(`Web shell ${intact ? 'cached' : 'built'}: ${shell.name} ${sourceHash.slice(0, 12)} (${((performance.now() - started) / 1000).toFixed(2)}s)`)
}

const entries = []
const revisions = new Map()
for (const fork of forks) {
  const repository = path.resolve(dsh, fork.repository ?? '.')
  if (repository === dsh) throw Error('Product builds must not overwrite official DSH packages: ' + fork.packageName)
  if (!revisions.has(repository)) {
    const result = spawnSync('git', ['-C', repository, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', windowsHide: true })
    if (result.error) throw result.error
    const revision = result.stdout.trim()
    if (result.status !== 0 || !/^[a-f0-9]{40,64}$/.test(revision)) throw Error('Cannot identify submodule revision: ' + repository)
    revisions.set(repository, revision)
  }
  const directory = path.join(repository, fork.packagePath ?? `packages/client/${fork.directory}`)
  const manifest = await read(path.join(directory, 'package.json'))
  // HeronAI-owned packages (owner: "heron-ai") build here but have no upstream source.
  const source = fork.owner === 'heron-ai' ? null : sources.sources[path.basename(repository)]
  if (fork.owner !== 'heron-ai' && (!source || path.resolve(project, source.directory) !== repository
    || source.upstreamCommit !== (fork.upstreamCommit ?? sources.sources.dsh.upstreamCommit))) throw Error('Workspace source identity differs: ' + directory)
  const installed = path.join(project, 'node_modules', manifest.name)
  if (await fs.realpath(installed) !== await fs.realpath(directory)) throw Error('Dependency is not a local workspace: ' + manifest.name)
  if (manifest[fork.markerField ?? 'heronAiFork'] !== fork.marker || manifest.version !== (fork.version ?? dshVersion)) throw Error('Workspace version or marker differs: ' + manifest.name)
  // Generated sources (such as an inlined asset module) must exist before the source inventory and compile.
  for (const script of fork.prepareScripts ?? []) {
    const result = spawnSync(process.execPath, [path.join(directory, script)], { cwd: directory, stdio: 'inherit', windowsHide: true })
    if (result.error) throw result.error
    if (result.status !== 0) throw Error('Workspace prepare failed: ' + manifest.name)
  }
  entries.push({ fork, repository, directory, manifest, source, revision: revisions.get(repository), files: await files(path.join(directory, 'src')) })
}
const byName = new Map(entries.map(entry => [entry.manifest.name, entry]))
for (const entry of entries) {
  entry.dependencies = new Set()
  for (const file of entry.files.filter(file => /\.(ts|tsx)$/.test(file))) {
    for (const imported of ts.preProcessFile(await fs.readFile(file, 'utf8'), true, true).importedFiles) {
      const name = imported.fileName.startsWith('@') ? imported.fileName.split('/').slice(0, 2).join('/') : imported.fileName.split('/')[0]
      if (byName.has(name) && name !== entry.manifest.name) entry.dependencies.add(byName.get(name))
    }
  }
}
const order = [], visiting = new Set(), visited = new Set()
function visit(entry) {
  if (visited.has(entry)) return
  if (visiting.has(entry)) throw Error('Workspace build cycle: ' + entry.manifest.name)
  visiting.add(entry)
  for (const dependency of entry.dependencies) visit(dependency)
  visiting.delete(entry); visited.add(entry); order.push(entry)
}
if (args.length) {
  const entry = byName.get(args[1])
  if (!entry) throw Error('Unknown build workspace: ' + args[1])
  visit(entry)
} else for (const entry of entries) visit(entry)

for (const entry of order) {
  const { fork, manifest, directory } = entry
  const tsconfig = path.join(tools, `tsconfig.${fork.directory}.json`)
  const projects = (fork.tsconfigs ?? [path.basename(tsconfig)]).map(file => path.join(tools, file))
  const bundleArtifacts = fork.artifacts ?? ['index.js', 'client.js']
  const artifacts = [...bundleArtifacts,
    ...(manifest.exports?.['./remote'] ? ['typert.host.js', 'typert.host.d.ts', 'typert.remote-client.js', 'typert.remote-client.d.ts'] : [])]
  const artifactHashes = () => Promise.all(artifacts.map(async name => [name, await digest(path.join(directory, 'lib', name))])).then(Object.fromEntries)
  const inputs = [
    ...entry.files, path.join(directory, 'package.json'), ...projects,
    ...['build.mjs', 'typert.mjs', 'package.json', 'forks.json'].map(file => path.join(tools, file)),
    path.join(project, 'pnpm-lock.yaml'), path.join(project, 'config/dsh-artifacts.lock.json'), sourcesFile,
    path.join(dsh, 'tsconfig.base.json'), path.join(dsh, 'tsconfig.base.client.json'),
    path.join(dsh, 'packages/client/tsdown.client.ts'), path.join(dsh, 'packages/client/modules/src/client/manifest.ts'),
    path.join(dsh, 'packages/client/web/src/platform.ts'), path.join(dsh, 'scripts/client-build-environment.ts'),
    path.join(dsh, 'scripts/bundle-input-isolation.ts'), path.join(dsh, 'scripts/types/client-build-environment/index.d.ts'),
  ]
  if (fork.buildScript) inputs.push(path.join(directory, fork.buildScript))
  for (const script of fork.prepareScripts ?? []) inputs.push(path.join(directory, script))
  if (fork.tsdownConfig) inputs.push(path.join(directory, fork.tsdownConfig))
  else if (!['node', 'community'].includes(fork.buildProfile)) inputs.push(path.join(directory, 'tsdown.config.ts'))
  if (manifest.exports?.['./remote']) inputs.push(path.join(dsh, 'tsconfig.host.json'), path.join(dsh, 'tsconfig.client.json'), path.join(directory, fork.hostPhase ? 'tsconfig.host.json' : 'tsconfig.json'))
  const hash = createHash('sha256')
  for (const file of inputs.sort()) hash.update(path.relative(project, file)).update('\0').update(await fs.readFile(file)).update('\0')
  for (const dependency of entry.dependencies) hash.update(dependency.record.sourceHash)
  const sourceHash = hash.digest('hex')
  // Build receipts belong with generated output. Some upstream repositories do
  // not ignore a root-level receipt, which would become a new source mid-build.
  const metadataFile = path.join(directory, 'lib', 'heron-ai-fork.json')
  let cached
  try { cached = await read(metadataFile) } catch (error) { if (error.code !== 'ENOENT') throw error }
  let intact = false
  if (cached?.sourceHash === sourceHash) {
    try { intact = JSON.stringify(await artifactHashes()) === JSON.stringify(cached.artifactSha256) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if (!intact && fork.buildProfile === 'community') {
    for (const config of projects) {
      const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', config], { cwd: dsh, stdio: 'inherit', windowsHide: true })
      if (result.error) throw result.error
      if (result.status !== 0) throw Error('Workspace compilation failed: ' + manifest.name)
      if (config === projects[0] && manifest.exports?.['./remote']) {
        const model = analyzeProduct({ root: dsh, packages: [manifest.name], faces: ['host'], checkDiagnostics: false })
        const artifact = new FaceModelEmitter(model.faces[0]).emit(manifest.name)
        await fs.writeFile(path.join(directory, 'lib/typert.host.js'), artifact.js)
        await fs.writeFile(path.join(directory, 'lib/typert.host.d.ts'), artifact.dts)
        if (artifact.remote) {
          await fs.writeFile(path.join(directory, 'lib/typert.remote-client.js'), artifact.remote.js)
          await fs.writeFile(path.join(directory, 'lib/typert.remote-client.d.ts'), artifact.remote.dts)
          await fs.writeFile(path.join(directory, 'lib/typert.remote-client.d.ts.map'), artifact.remote.dtsMap)
        }
      }
    }
    if (fork.buildScript) {
      const result = spawnSync(process.execPath, [path.join(directory, fork.buildScript)], { cwd: directory, stdio: 'inherit', windowsHide: true })
      if (result.error) throw result.error
      if (result.status !== 0) throw Error('Workspace bundle failed: ' + manifest.name)
    } else if (fork.tsdownConfig) {
      // Community plugins may own multiple lazy bundles; preserve their declared build graph.
      await build({ config: path.join(directory, fork.tsdownConfig), cwd: directory })
    } else {
      let config
      if (!manifest.dsh?.client) {
        const dependencies = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]
        const shared = { outDir: 'lib', platform: 'node', target: 'es2024', fixedExtension: false,
          dts: false, clean: false, deps: { neverBundle: [/^@deepseek-ai\//, ...dependencies] } }
        config = () => [
          ...bundleArtifacts.filter(file => !file.endsWith('.cjs')).map(file => ({
            ...shared, entry: ['lib/types/' + file], format: 'esm',
          })),
          ...Object.entries(fork.cjsEntries ?? {}).map(([name, file]) => ({
            ...shared, entry: { [name]: 'lib/types/' + file }, format: 'cjs',
          })),
        ]
      } else {
        const { clientBundle } = await import(pathToFileURL(path.join(dsh, 'packages/client/tsdown.client.ts')).href)
        config = clientBundle(directory, ['lib/types/index.js', ...(fork.invariant ? ['lib/types/invariant.js'] : [])])
      }
      for (const phase of fork.hostPhase ? ['host', 'client'] : ['client']) {
        for (const face of config({ env: { DSH_BUILD_FACE: phase } })) await build({ ...face,
          ...(fork.directory === 'dsh-mcp-manager'
            ? { define: { ...face.define, __DSH_MCP_MANAGER_VERSION__: JSON.stringify(byName.get('dsh-mcp-manager').manifest.version) } } : {}),
          config: false, cwd: directory, tsconfig: face.platform === 'browser' ? projects[1] : projects[0] })
      }
    }
  }
  entry.record = { name: manifest.name, version: manifest.version, revision: entry.revision,
    upstreamTag: entry.source?.upstreamTag ?? null, upstreamCommit: entry.source?.upstreamCommit ?? null,
    dshVersion, inputApi: 1, sourceHash, artifactSha256: await artifactHashes(),
    hostSha256: await digest(path.join(directory, 'lib', artifacts[0])),
    ...(artifacts.includes('client.js') ? { clientSha256: await digest(path.join(directory, 'lib/client.js')) } : {}),
  }
  await fs.writeFile(metadataFile, JSON.stringify(entry.record, null, 2) + '\n')
  console.log('Workspace built: ' + manifest.name + ' ' + sourceHash.slice(0, 12))
}
if (!args.length) {
  await fs.mkdir(path.join(project, '.cache'), { recursive: true })
  await fs.writeFile(path.join(project, '.cache/workspace-build.json'), JSON.stringify({ forks, packages: entries.map(entry => entry.record) }, null, 2) + '\n')
}
