import fs from 'node:fs/promises'
import { existsSync, lstatSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { assembleDependencies } from './dependencies.mjs'
import { prepareDshArtifacts } from './dsh-artifacts.mjs'
import { writeDevelopmentContext } from './plugin-dev-context.mjs'
import { bundleNode } from './node-runtime.mjs'
import { buildReceipt } from './build-receipt.mjs'
import { payloadInputs } from './payload-inputs.mjs'
import { pluginBundleInputs, bundleFileIncluded } from './plugin-bundles.mjs'
import { readMcpBuildInputs } from './mcp-build-inputs.mjs'
import { visibleSourceFiles } from './source-inventory.mjs'
import { assertPublicPayload } from './public-payload.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const product = path.join(root, 'packages/common/runtime')
const source = path.join(product, 'src')
const args = process.argv.slice(2)
const options = new Map(), pluginDirectories = []
for (let i = 0; i < args.length; i += 2) {
  if (!['--output', '--bundle-plugin', '--bundle-manifest'].includes(args[i]) || !args[i + 1]) throw Error('Usage: build.mjs [--output <app>] [--bundle-manifest <composition.json> | --bundle-plugin <DSH plugin directory>...]')
  if (args[i] === '--bundle-plugin') pluginDirectories.push(args[i + 1])
  else {
    if (options.has(args[i])) throw Error('Duplicate build option: ' + args[i])
    options.set(args[i], args[i + 1])
  }
}
const bundle = pluginBundleInputs(options.get('--bundle-manifest'), pluginDirectories)
const bundledPlugins = bundle.directories
const mcpBuildInputs = readMcpBuildInputs(bundledPlugins, bundle.mcpSecretsFile)
const output = path.resolve(options.get('--output') ?? path.join(root, 'dist/app'))
const host = path.join(output, 'AiHost')
const cache = path.join(root, '.cache')
if (process.platform === 'win32') {
  // esbuild transfers large transforms through temporary files. Use the build's
  // own writable directory instead of the system Temp, where deletion can be
  // denied even though the transfer file was created successfully.
  const temporary = path.join(cache, 'tmp')
  await fs.mkdir(temporary, { recursive: true })
  process.env.TEMP = temporary
  process.env.TMP = temporary
}
const within = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)) }
if ([path.join(root, 'packages'), path.join(root, 'scripts'), path.join(root, 'node_modules'), path.join(cache, 'ui')].some(directory => within(output, directory) || within(directory, output))) throw Error('Build output overlaps product sources or dependencies')

function run(file, argv, cwd = root, allowed = [0], env = process.env) {
  const result = spawnSync(file, argv, { cwd, env, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (!allowed.includes(result.status)) throw Error(`${file} failed (${result.status})`)
}
const node = (file, argv = [], cwd = root) => run(process.execPath, [file, ...argv], cwd)
const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
const npm = (argv, cwd) => node(npmCli, argv, cwd)
const pnpm = (argv, cwd) => process.platform === 'win32'
  ? run('cmd.exe', ['/d', '/c', 'pnpm', ...argv], cwd, [0], pnpmEnvironment())
  : run('pnpm', argv, cwd, [0], pnpmEnvironment())
function pnpmEnvironment() {
  return { ...process.env, PNPM_CONFIG_WORKSPACE_DIR: root }
}
async function exists(file) { try { await fs.access(file); return true } catch (error) { if (error.code !== 'ENOENT') throw error; return false } }
async function fingerprint(files) {
  const hash = createHash('sha256')
  for (const file of files) hash.update(file).update('\0').update(await fs.readFile(file)).update('\0')
  return hash.digest('hex')
}
async function listFiles(directory) {
  const files = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw Error('Product source or output contains a link: ' + file)
    if (entry.isDirectory()) files.push(...await listFiles(file))
    else if (entry.isFile() && visibleSourceFiles(root).has(path.resolve(file))) files.push(file)
  }
  return files.sort()
}
async function sourceFiles(directory) {
  const files = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'tests', 'web', 'ui', 'packages'].includes(entry.name) && entry.isDirectory()) continue
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw Error('Product source contains a link: ' + file)
    if (entry.isDirectory()) files.push(...await sourceFiles(file))
    else if (!entry.name.endsWith('.map') && visibleSourceFiles(root).has(path.resolve(file))) files.push(file)
  }
  return files
}
async function mirror(sourceDirectory, targetDirectory, { sourceMaps = false } = {}) {
  await fs.mkdir(targetDirectory, { recursive: true })
  if (process.platform === 'win32') {
    // Both paths are fixed product output descendants, never user state directories.
    if (!within(output, targetDirectory)) throw Error('Mirror target is outside this build output')
    run('robocopy', [sourceDirectory, targetDirectory, '/MIR', ...(sourceMaps ? [] : ['/XF', '*.map']), '/R:2', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], root, [0, 1, 2, 3, 4, 5, 6, 7])
  } else {
    if (!within(output, targetDirectory)) throw Error('Mirror target is outside this build output')
    await fs.rm(targetDirectory, { recursive: true, force: true })
    await fs.cp(sourceDirectory, targetDirectory, { recursive: true, filter: file => sourceMaps || !file.endsWith('.map') })
  }
}

// Explicit bundled plugins can inject private, environment-dependent build inputs.
// Their release pipeline verifies the versioned package before reusing it.
const component = bundledPlugins.length ? null : buildReceipt(root, 'AI payload:' + output, () => payloadInputs(root), [output], 'payload-v1')
if (component?.reusable) process.exit(0)
await fs.mkdir(cache, { recursive: true })
for (const name of ['dsh', 'community/dsh-mcp-manager', 'community/dsh-skill-manager', 'community/dsh-better-sidebar']) {
  if (!(await exists(path.join(root, 'packages', name, '.git'))) || !(await exists(path.join(root, 'packages', name, 'package.json')))) {
    throw Error('Submodule is not initialized: ' + name + '. Run git submodule update --init --recursive.')
  }
}
const workspace = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
// A trailing /* entry stands for every package directory directly below it.
const workspaceDirectories = (await Promise.all(workspace.workspaces.map(async directory => {
  if (!directory.endsWith('/*')) return [directory]
  const parent = directory.slice(0, -2)
  const entries = await fs.readdir(path.join(root, parent), { withFileTypes: true })
  return entries.filter(entry => entry.isDirectory()).map(entry => parent + '/' + entry.name)
    .filter(child => existsSync(path.join(root, child, 'package.json'))).sort()
}))).flat()
const sdkInputs = [path.join(root, 'package.json'), path.join(root, 'pnpm-lock.yaml'), path.join(root, 'pnpm-workspace.yaml'), path.join(root, '.pnpmfile.cjs'), ...workspaceDirectories.map(directory => path.join(root, directory, 'package.json'))]
const sdkHash = await fingerprint(sdkInputs)
const sdkStamp = path.join(cache, 'dependencies.source.json')
if (!(await exists(path.join(root, 'node_modules/.modules.yaml'))) || !(await exists(sdkStamp)) || await fs.readFile(sdkStamp, 'utf8') !== sdkHash) {
  pnpm(['install', '--frozen-lockfile'], root)
  await fs.writeFile(sdkStamp, sdkHash)
}
await prepareDshArtifacts(root)
npm(['run', 'build', '--workspace=@heron-ai/dsh-build'], root)

const web = path.join(root, 'packages/common/ui')
const webInputs = [path.join(web, 'package.json'), path.join(root, 'pnpm-lock.yaml'), path.join(web, 'vite.widgets.config.ts'), path.join(web, 'tsconfig.json'), ...await listFiles(path.join(web, 'src')), ...await listFiles(path.join(product, 'assets'))]
const webHash = await fingerprint(webInputs)
const webStamp = path.join(cache, 'ui.source.json')
if (!(await exists(path.join(cache, 'ui/widgets.js'))) || !(await exists(path.join(cache, 'ui/widgets.js.map'))) || !(await exists(webStamp)) || await fs.readFile(webStamp, 'utf8') !== webHash) {
  npm(['run', 'build', '--workspace=@common/ui'], root)
  await fs.writeFile(webStamp, webHash)
}

await fs.mkdir(host, { recursive: true })
const timings = []
async function stage(name, run) {
  const start = Date.now()
  try { await run() } finally { timings.push([name, Date.now() - start]) }
}
await stage('assemble-dependencies', () => assembleDependencies(root, product, host))
// DSH plugins kept outside this checkout ship preinstalled: copied into the pruned payload
// (pruning keeps only the product graph; the next assembly removes them) and listed for one-time activation.
const BUNDLED_PLUGINS_FILE = path.join('heron-ai', 'content', 'bundled-plugins.json')
async function bundlePlugins(directories) {
  const names = []
  for (const directory of directories) {
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'))
    if (typeof manifest.name !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(manifest.name)) throw Error('Bundled plugin needs an unscoped package name: ' + directory)
    if (typeof manifest.dsh?.bundle?.patch !== 'string') throw Error('Bundled plugin declares no DSH bundle patch: ' + manifest.name)
    if (Object.keys(manifest.dependencies ?? {}).length) throw Error('Bundled plugin must not carry its own dependencies: ' + manifest.name)
    const target = path.join(host, 'node_modules', manifest.name)
    if (names.includes(manifest.name) || existsSync(target)) throw Error('Bundled plugin collides with a product dependency: ' + manifest.name)
    for (const name of Object.keys(manifest.peerDependencies ?? {}))
      if (!existsSync(path.join(host, 'node_modules', name, 'package.json'))) throw Error('Bundled plugin ' + manifest.name + ' needs ' + name + ', which the product does not ship')
    await fs.cp(directory, target, { recursive: true, filter: file => {
      const stat = lstatSync(file)
      if (stat.isSymbolicLink()) throw Error('Bundled plugin contains a link: ' + file)
      return bundleFileIncluded(manifest, path.relative(directory, file), stat.isDirectory())
    } })
    // Optional content belongs to its package. Only explicitly bundled copies
    // receive assembly credentials; neither the source nor public defaults do.
    const mcpContent = manifest.heronAi?.content?.['mcp-config.json']
    if (mcpContent !== undefined) {
      if (typeof mcpContent !== 'string') throw Error('Invalid bundled MCP content path')
      const file = path.resolve(target, mcpContent)
      if (!within(target, file) || file === target) throw Error('Bundled MCP content is outside its package')
      const config = JSON.parse(await fs.readFile(file, 'utf8'))
      for (const server of Object.values(config.mcpServers ?? {})) {
        if (!server.bearerTokenEnv) continue
        const token = mcpBuildInputs.tokens.get(server.bearerTokenEnv)
        if (!token) throw Error('MCP build credential reference changed during assembly')
        server.bearerToken = token
        delete server.bearerTokenEnv
      }
      await fs.writeFile(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
    }
    names.push(manifest.name)
    console.log('[bundle-plugins] ' + manifest.name + ' ' + (manifest.version ?? '') + ' <- ' + directory)
  }
  await fs.mkdir(path.join(host, path.dirname(BUNDLED_PLUGINS_FILE)), { recursive: true })
  await fs.writeFile(path.join(host, BUNDLED_PLUGINS_FILE), JSON.stringify(names) + '\n')
}
const runtimeFiles = await sourceFiles(source)
const keep = new Set(runtimeFiles.map(file => path.relative(source, file)))
keep.add('package.json'); keep.add('package-lock.json'); keep.add(BUNDLED_PLUGINS_FILE); keep.add('.heron-ai-assembly.json'); keep.add('plugin-dev-context.json')
for (const file of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) keep.add(file)
await stage('source-copy', async () => {
  for (const file of runtimeFiles) {
    const target = path.join(host, path.relative(source, file))
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(file, target)
  }
})
async function removeOrphans(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    const relative = path.relative(host, file).replaceAll('\\', '/')
    if (['node_modules', 'dsh/web', 'heron-ai/ui', 'heron-ai/content/skills', 'heron-ai/content/templates'].includes(relative)) continue
    if (entry.isSymbolicLink()) throw Error('Product output contains a link: ' + file)
    if (entry.isDirectory()) {
      await removeOrphans(file)
      if (!(await fs.readdir(file)).length) await fs.rmdir(file)
    }
    else if (!keep.has(path.relative(host, file)) && relative !== 'heron-ai/content/runtime-logo.svg') await fs.unlink(file)
  }
}
await stage('remove-orphans', () => removeOrphans(host))
await stage('license-notices', async () => {
  for (const file of ['LICENSE', 'THIRD-PARTY-NOTICES.md'])
    await fs.copyFile(path.join(root, file), path.join(host, file))
})
// Public content is local to the runtime. Optional packages own their skills,
// templates and references and are copied only through the selected bundle.
await stage('mirror-business-content', async () => {
  await mirror(path.join(source, 'heron-ai/content/skills'), path.join(host, 'heron-ai/content/skills'))
  // The product ships an empty catalog. Business templates are contributed by
  // optional plugins, never copied back into the generic template directory.
  await mirror(path.join(source, 'heron-ai/content/templates'), path.join(host, 'heron-ai/content/templates'))
  for (const file of ['product.json', 'provider-catalog.json', 'mcp-config.json'])
    await fs.copyFile(path.join(source, 'heron-ai/content', file), path.join(host, 'heron-ai/content', file))
})
const require = createRequire(path.join(product, 'package.json'))
const frontend = path.join(path.dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist')
await stage('mirror-web', () => mirror(frontend, path.join(host, 'dsh/web')))
await stage('mirror-ui', () => mirror(path.join(cache, 'ui'), path.join(host, 'heron-ai/ui'), { sourceMaps: true }))
await stage('mirror-assets', () => mirror(path.join(product, 'assets'), path.join(host, 'heron-ai/assets')))
await fs.copyFile(path.join(product, 'assets/runtime-logo.svg'), path.join(host, 'heron-ai/content/runtime-logo.svg'))
await stage('prune-distribution', () => node(path.join(root, 'scripts/prune-distribution.mjs'), [host]))
await stage('bundle-plugins', () => bundlePlugins(bundledPlugins))
await stage('plugin-development-context', () => writeDevelopmentContext(host, path.join(web, 'src')))
if (!bundledPlugins.length) await stage('public-payload', () => assertPublicPayload(host))
await stage('verify-payload', () => node(path.join(root, 'scripts/verify-payload.mjs'), [host, '--source', source]))
await stage('bundle-node', () => bundleNode(root, output))
component?.commit()
const total = timings.reduce((sum, [, ms]) => sum + ms, 0)
for (const [name, ms] of timings.sort((a, b) => b[1] - a[1])) {
  console.log(`[timing] ${name.padEnd(22)} ${(ms / 1000).toFixed(1)}s`)
}
console.log(`[timing] ${'(post-build stages)'.padEnd(22)} ${(total / 1000).toFixed(1)}s`)
console.log('Heron.AI product ready: ' + output)
