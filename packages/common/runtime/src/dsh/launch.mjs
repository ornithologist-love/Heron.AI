// The official-direct launch shared by the product's hosts. The installed
// DSH files stay intact; each host supplies its own home and a native Include.
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire, registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { prepareRcProfileEntries } from '../heron-ai/migration/settings-rc.mjs'
import { resolveHostProfile } from '../heron-ai/host-profile.mjs'
import { excludedPackage } from './distribution.mjs'
import { findBrowserLoopbackPort } from './browser-port.mjs'
import { HERON_AI_THEMES } from '../heron-ai/themes/palettes.mjs'
import { providerCatalogUrl } from '../heron-ai/acp/runtime/provider-directory.mjs'
import { productProfile } from '../heron-ai/product-profile.mjs'
import { bundledPluginSelection } from '../heron-ai/bundled-plugins.mjs'

const require = createRequire(import.meta.url)
const PRODUCT_BUNDLE = '@heron-ai/dsh-profile'
const hostRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Plugins the release build shipped preinstalled (build.mjs --bundle-plugin) join the
// product's optional bundles: turned on once per profile, switchable on the plugin page.
const shippedBundles = (() => {
  try { return JSON.parse(readFileSync(path.join(hostRoot, 'heron-ai', 'content', 'bundled-plugins.json'), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
})()
// DSH imports bundle rows from the profile directory, which has no node_modules for a shipped
// plugin; its package and subpaths resolve from this payload, like packageNamedRows below.
if (shippedBundles.length) {
  const parentURL = pathToFileURL(path.join(hostRoot, 'package.json')).href
  registerHooks({ resolve: (specifier, context, next) =>
    shippedBundles.some(name => specifier === name || specifier.startsWith(name + '/'))
      ? next(specifier, { ...context, parentURL }) : next(specifier, context) })
}
export const DSH_VERSION = '0.2.2-rc.1'
// The model server every host defaults to comes from the deployment's product profile;
// --server-url overrides it. A payload without a profile has no default server.
export const DEFAULT_SERVER_URL = productProfile.serverUrl ?? null

export function launchOptions(argv) {
  const values = {}
  const accepted = new Set(['config', 'token', 'state-dir', 'credential-root', 'ready-file', 'local-root', 'server-url', 'skills-dir', 'templates-dir', 'static-root', 'dev-origin', 'workspace', 'port', 'identity-file', 'mcp-config', 'host-theme', 'host-integration', 'host-edition', 'reserved-mcp-endpoint', 'development-hmr'])
  const reservedMcpEndpoints = []
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.slice(2)
    if (!argv[i]?.startsWith('--') || !accepted.has(key) || argv[i + 1] === undefined)
      throw new Error('Invalid AIHost launch arguments')
    if (key === 'reserved-mcp-endpoint') reservedMcpEndpoints.push(argv[i + 1])
    else values[key] = argv[i + 1]
  }
  const configured = values.config ? JSON.parse(readFileSync(path.resolve(values.config), 'utf8')) : {}
  if (values['development-hmr'] !== undefined && !['true', 'false'].includes(values['development-hmr']))
    throw new Error('development-hmr must be true or false')
  const base = values.config ? path.dirname(path.resolve(values.config)) : process.cwd()
  const absolute = value => value ? path.resolve(base, value) : undefined
  return hostOptions({ ...configured,
    developmentHmr: values['development-hmr'] === 'true',
    ...(values['state-dir'] && { stateDir: absolute(values['state-dir']) }),
    ...(values.workspace && { workspace: absolute(values.workspace) }),
    ...(values.port && { port: Number(values.port) }),
    ...(values['credential-root'] && { credentialRoot: absolute(values['credential-root']) }),
    ...(values['ready-file'] && { readyFile: absolute(values['ready-file']) }),
    ...(values['local-root'] && { localRoot: absolute(values['local-root']) }),
    ...(values['skills-dir'] && { skillsDir: absolute(values['skills-dir']) }),
    ...(values['templates-dir'] && { templatesDir: absolute(values['templates-dir']) }),
    ...(values['identity-file'] && { identityFile: absolute(values['identity-file']) }),
    ...(values['mcp-config'] && { mcpConfigFile: absolute(values['mcp-config']) }),
    ...(values['server-url'] && { serverUrl: values['server-url'] }),
    ...(values.token && { shellToken: values.token }),
    ...(values['host-theme'] && { hostTheme: values['host-theme'] }),
    ...(values['host-integration'] && { hostIntegration: values['host-integration'] }),
    ...(values['host-edition'] && { hostEdition: values['host-edition'] }),
    ...(reservedMcpEndpoints.length && { reservedMcpEndpoints: [...(configured.reservedMcpEndpoints ?? []), ...reservedMcpEndpoints] }),
  }, base)
}

function isMcpEndpoint(value) {
  let url
  try { url = new URL(value) } catch { return false }
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
}

export function hostOptions(config = {}, base = process.cwd()) {
  const absolute = value => value ? path.resolve(base, value) : null
  const suppliedHost = process.env.HERON_AI_HOST_METADATA ? JSON.parse(process.env.HERON_AI_HOST_METADATA) : undefined
  const hostMetadata = config.hostMetadata ?? suppliedHost
  // The launching host's build wins over private reporting overrides; unknown hosts stay non-development.
  const hostBuild = suppliedHost?.build ?? hostMetadata?.build
  const hmrEnabled = (typeof hostBuild === 'string' && hostBuild.toLowerCase() === 'debug') || config.developmentHmr === true
  const stateDir = absolute(config.stateDir) ?? path.join(os.homedir(), '.heron-ai')
  const port = Number(config.port ?? 0)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid AIHost port')
  if (config.shellToken && !/^[0-9a-f]{16,128}$/.test(config.shellToken)) throw new Error('Invalid shell token')
  if (config.hostTheme != null && !['light', 'dark'].includes(config.hostTheme)) throw new Error('Invalid host theme')
  if (config.hostIntegration != null && !/^[a-z][a-z0-9_-]*$/.test(config.hostIntegration)) throw new Error('Invalid host integration')
  if (config.hostEdition != null && (typeof config.hostEdition !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(config.hostEdition))) throw new Error('Invalid host edition')
  // Endpoints the host serves through its own admitted tools (HOST-INTEGRATION H2.1):
  // the MCP Manager never connects to them directly, under any server name.
  if (config.reservedMcpEndpoints !== undefined && (!Array.isArray(config.reservedMcpEndpoints)
      || config.reservedMcpEndpoints.some(value => !isMcpEndpoint(value))))
    throw new Error('Invalid reserved MCP endpoint')
  if (config.includeUserSkillRoots !== undefined && typeof config.includeUserSkillRoots !== 'boolean')
    throw new Error('Invalid user skill root preference')
  if (config.bundledMcpServers !== undefined && (!Array.isArray(config.bundledMcpServers)
      || config.bundledMcpServers.some(name => typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(name))
      || new Set(config.bundledMcpServers).size !== config.bundledMcpServers.length))
    throw new Error('Invalid bundled MCP server selection')
  if (config.bundledMcpServersEnabled !== undefined && typeof config.bundledMcpServersEnabled !== 'boolean')
    throw new Error('Invalid bundled MCP server default state')
  // Business packages: the host profile gives the default; an explicit
  // --config aspects list overrides it.
  if (config.aspects !== undefined && (!Array.isArray(config.aspects) || config.aspects.some(aspect => typeof aspect !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(aspect))
      || new Set(config.aspects).size !== config.aspects.length))
    throw new Error('Invalid business aspects')
  const hostIntegration = config.hostIntegration ?? 'none'
  const profile = resolveHostProfile(hostIntegration, config.aspects)
  return {
    stateDir,
    credentialRoot: absolute(config.credentialRoot) ?? stateDir,
    home: path.join(stateDir, 'dsh'),
    workspace: absolute(config.workspace) ?? process.cwd(),
    localRoot: absolute(config.localRoot) ?? stateDir,
    skillsDir: absolute(config.skillsDir) ?? path.join(stateDir, 'content', 'skills'),
    templatesDir: absolute(config.templatesDir) ?? path.join(stateDir, 'content', 'templates'),
    providerCatalogUrl: config.providerCatalogUrl ?? providerCatalogUrl(config.serverUrl ?? DEFAULT_SERVER_URL),
    identityFile: absolute(config.identityFile),
    preferPublicDefault: config.preferPublicDefault,
    mcpConfigFile: absolute(config.mcpConfigFile),
    brandLogo: absolute(config.brandLogo),
    branding: config.branding !== false,
    heronAiThemes: config.heronAiThemes !== false,
    hostTheme: config.hostTheme ?? null,
    hostIntegration,
    hostEdition: config.hostEdition ?? 'user',
    managedModelGateway: !!process.env.HERON_AI_MODEL_GATEWAY_URL,
    hostMetadata,
    hmrEnabled,
    hostPackage: profile.hostPackage,
    hostPackageBundle: profile.hostPackageBundle,
    aspects: profile.aspects,
    includeUserSkillRoots: config.includeUserSkillRoots !== false,
    bundledMcpServers: config.bundledMcpServers,
    bundledMcpServersEnabled: config.bundledMcpServersEnabled !== false,
    serverUrl: config.serverUrl ?? null,
    shellToken: config.shellToken ?? null,
    reservedMcpEndpoints: config.reservedMcpEndpoints ?? [],
    hostRoot,
    port,
    readyFile: absolute(config.readyFile),
    extensionSettings: config.extensions ?? config,
  }
}

export async function launchDsh(options, include) {
  if (options.port === 0) options.port = await findBrowserLoopbackPort()
  const manifest = require('@deepseek-ai/dsh/package.json')
  if (manifest.version !== DSH_VERSION) throw new Error('The pinned DSH runtime is required')
  await fs.mkdir(options.home, { recursive: true })
  const { initProfile, resolveProfileDir } = await import('@deepseek-ai/dsh-app-boot')
  const profileDir = resolveProfileDir('web', options.home)
  initProfile(profileDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  const overlay = path.join(options.home, 'heron-ai-host.patch.json')
  const nativeEntries = {
    'heron-ai-client-modules': 'modules',
    'heron-ai-sidebar': 'ui-sidebar', 'heron-ai-skill-selection': 'ui-skill',
    'heron-ai-standard-preset': 'preset-standard',
    'heron-ai-agent-presets': 'agent-preset-registry',
    'heron-ai-model-settings': 'ui-settings-models',
    'heron-ai-session-controller': 'session-controller',
    'heron-ai-permission-selection': 'ui-permission', 'heron-ai-preset-selection': 'ui-agent-preset',
    'heron-ai-conversation': 'ui-conversation',
  }
  const includeRequire = createRequire(include)
  // Official Better Sidebar matches `entry.options.name === 'dsh-better-sidebar'` to address its settings form.
  const packageNamedRows = new Set(['dsh-better-sidebar'])
  const overrides = [], additions = []
  const stableEntries = new Map()
  const entryRoot = path.join(options.home, 'runtime', 'heron-ai-profile', 'entries')
  await fs.mkdir(entryRoot, { recursive: true })
  for (const row of JSON.parse(await fs.readFile(include, 'utf8'))) {
    const nativeId = nativeEntries[row.id]
    if (nativeId) {
      // The official row still needs the session policy and the deferred
      // configuration store the product supplies; the saved row replaces it.
      if (row.id === 'heron-ai-session-controller') row.config = { ...row.config, policyRequired: true, configurationDirectory: path.join(options.home, 'session-configurations') }
      overrides.push({ id: nativeId, ...(row.config === undefined ? {} : { config: row.config }) })
      // A saved profile row replaces the composed config; migration restores product fields into it.
      stableEntries.set(nativeId, { name: row.name, config: row.config })
    } else {
      // Integration rows may already name a file URL; CommonJS resolution needs its filesystem path.
      let name = pathToFileURL(includeRequire.resolve(row.name.startsWith('file:') ? fileURLToPath(row.name) : row.name)).href
      if (row.name.startsWith('@heron-ai/dsh-heron-ai/settings/') || row.id === 'heron-ai-llm-pi-ai') {
        const file = path.join(entryRoot, row.id + '.mjs')
        await writeFileAtomic(file, `export * from ${JSON.stringify(name)};\n`, { mode: 0o600 })
        stableEntries.set(row.id, { name: pathToFileURL(file).href, suffix: row.name.slice('@heron-ai/dsh-heron-ai'.length) + '.mjs' })
        name = pathToFileURL(file).href
      }
      // Client discovery needs the real package manifest, not a host-only wrapper.
      if (['heron-ai-mcp-manager', 'heron-ai-skill-manager'].includes(row.id)) stableEntries.set(row.id, { name, config: row.config })
      // A community package that finds its own loader row by package name keeps the bare name.
      // DSH resolves rows from its home, which has no node_modules, so the package and its
      // subpaths resolve from this payload instead.
      if (packageNamedRows.has(row.name)) {
        const parentURL = pathToFileURL(include).href
        registerHooks({ resolve: (specifier, context, next) => specifier === row.name || specifier.startsWith(row.name + '/')
          ? next(specifier, { ...context, parentURL }) : next(specifier, context) })
        name = row.name
      }
      additions.push({ ...row, name })
    }
  }
  await prepareRcProfileEntries(profileDir, options.stateDir, stableEntries, HERON_AI_THEMES)
  const deployment = [
    { id: 'llm-pi-ai', disabled: true },
    { id: 'web', disabled: true },
    // The product layer itself stays selected; the plugin page shows it read-only.
    { id: 'plugin-manager', config: { protectedBundles: [PRODUCT_BUNDLE, ...options.hostPackageBundle ? [options.hostPackageBundle] : []] } },
    { id: 'ui-schedule', disabled: true },
    // One stuck tool must not hold a turn forever; waiting tools (questions, subagents, jobs) are exempt.
    { id: 'tools', config: { maxCallMs: 5 * 60_000 } },
    // The Web profile ships the right-Sidebar Browser disabled; HeronAI opts in (iframe tabs, user-only, no model tools).
    { id: 'ui-sidebar-browser', disabled: false },
    // The official campaign label replaces the provider-qualified product label.
    { id: 'ui-deepseek-model-label-1017', disabled: true },
    ...(options.branding ? [{ id: 'ui-brand-official', disabled: true }] : []),
    ...overrides,
    { insert: additions },
  ]
  await installProductBundle(profileDir, options.home, deployment)
  const watchRoots = options.hmrEnabled ? await hmrWatchRoots(options.hostRoot, include, profileDir) : []
  await fs.writeFile(overlay, JSON.stringify([
    { id: 'web-runtime', config: { openBrowser: false, printUrl: false } },
    { id: 'webserver', config: { host: '127.0.0.1', port: options.port } },
    { id: 'session-log-deepseek', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'plugin-package-inventory-deepseek', disabled: true },
    { id: 'client-hmr', disabled: !options.hmrEnabled },
    { id: 'hmr', disabled: false, config: {
      base: pathToFileURL(options.hostRoot + path.sep).href,
      includeNodeModules: true,
      watch: options.hmrEnabled,
      root: watchRoots,
      followSymlinks: false,
      // Package roots are explicit, including profile-installed links. Never recurse into their dependencies.
      ignored: ['**/.git', '**/node_modules', '**/.cache', '**/.work', '**/*.map', '**/*.d.ts'],
    } },
  ], null, 2))
  process.env.DSH_HOME = options.home
  process.env.HERON_AI_DSH_LAUNCH = JSON.stringify(options)
  process.chdir(options.workspace)
  const cli = path.join(path.dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js')
  process.argv = [process.execPath, cli, '--profile', 'web', '--patch', overlay,
    '--no-open', '--host', '127.0.0.1', '--port', String(options.port)]
  const { runCli } = await import(pathToFileURL(cli).href)
  await runCli()
}

async function hmrWatchRoots(host, include, profileDir) {
  const candidates = [path.join(host, 'heron-ai'), profileDir, ...await compositionWatchRoots(include)]
  async function packages(modules, entries) {
    entries ??= await fs.readdir(modules)
    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      const directory = path.join(modules, entry)
      try {
        if (entry.startsWith('@')) {
          for (const name of await fs.readdir(directory)) candidates.push(path.join(directory, name))
        } else if ((await fs.stat(directory)).isDirectory()) candidates.push(directory)
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
  await packages(path.join(host, 'node_modules'), ['@deepseek-ai', '@common', '@heron-ai', '@host',
    'dsh-mcp-manager', 'dsh-skill-manager', 'dsh-better-sidebar'])
  await packages(path.join(profileDir, 'node_modules'))
  const roots = new Map()
  for (const candidate of candidates) {
    try {
      const real = await fs.realpath(candidate)
      roots.set(process.platform === 'win32' ? real.toLowerCase() : real, real)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return [...roots.values()]
}

async function generatedProductCopy(directory) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'))
    return manifest.name === PRODUCT_BUNDLE && manifest.heronAiGenerated === true
  } catch { return false }
}

async function compositionWatchRoots(include) {
  const modules = path.join(path.dirname(include), 'node_modules')
  const roots = [include]
  for (const entry of await fs.readdir(modules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const directory = path.join(modules, entry.name)
    if (!entry.name.startsWith('@')) { roots.push(directory); continue }
    for (const child of await fs.readdir(directory, { withFileTypes: true })) {
      if (child.isDirectory() && !child.isSymbolicLink()) roots.push(path.join(directory, child.name))
    }
  }
  return roots
}

// Product defaults form a native bundle layer below the user's profile edits.
// Keeping them out of --patch lets ConfigEditor persist volatile values.
async function installProductBundle(profileDir, home, patches) {
  const name = PRODUCT_BUNDLE
  const bundle = path.join(home, 'runtime', 'heron-ai-profile')
  const linked = path.join(profileDir, 'node_modules', '@heron-ai', 'dsh-profile')
  await fs.mkdir(bundle, { recursive: true })
  await withFileLock(path.join(profileDir, 'package.json'), async () => {
    const patchName = `cordis-${process.pid}.patch.json`
    await writeFileAtomic(path.join(bundle, patchName), JSON.stringify(patches, null, 2), { mode: 0o600 })
    await writeFileAtomic(path.join(bundle, 'package.json'), JSON.stringify({
      name, version: '1.0.0', private: true, type: 'module',
      heronAiGenerated: true, dsh: { bundle: { patch: './' + patchName } },
      peerDependencies: { '@deepseek-ai/dsh-app-boot': DSH_VERSION },
    }, null, 2), { mode: 0o600 })
    await fs.mkdir(path.dirname(linked), { recursive: true })
    let existing
    try { existing = await fs.lstat(linked) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    // pnpm materializes a `file:` directory dependency as a copy when the plugin manager
    // installs another bundle. Replace such a stale generated copy with the link again.
    if (existing && !existing.isSymbolicLink() && await generatedProductCopy(linked)) {
      await fs.rm(linked, { recursive: true, force: true })
      existing = undefined
    }
    if (existing) {
      if (!existing.isSymbolicLink() || path.resolve(await fs.realpath(linked)) !== path.resolve(bundle))
        throw Error('The HERON_AI profile bundle path is occupied by another package')
    } else await fs.symlink(bundle, linked, 'junction')
    const manifestPath = path.join(profileDir, 'package.json')
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    const profile = manifest.dsh?.profile
    if (!profile || !Array.isArray(profile.bundles)) throw Error('The DSH web profile has no bundle list')
    const removed = profile.bundles.filter(excludedPackage)
    let changed = removed.length > 0
    if (removed.length) {
      const backup = manifestPath + '.before-product-prune.bak'
      try { await fs.writeFile(backup,await fs.readFile(manifestPath),{ flag:'wx',mode:0o600 }) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
      profile.bundles = profile.bundles.filter(name => !excludedPackage(name))
      for (const name of removed) delete manifest.dependencies?.[name]
    }
    // Reconcile payload defaults before native composition, retaining user choices
    // across public/private payload changes without unresolved bundle references.
    const selection = bundledPluginSelection(manifest, shippedBundles)
    if (JSON.stringify(profile.bundles) !== JSON.stringify(selection.bundles)
      || JSON.stringify(manifest.heronAi) !== JSON.stringify(selection.metadata)) {
      profile.bundles = selection.bundles
      manifest.heronAi = selection.metadata
      changed = true
    }
    // Product defaults sit directly above the DSH bundles, so a host's own bundle
    // (such as an embedding host's) layers over them and can configure product rows.
    const others = profile.bundles.filter(entry => entry !== name)
    const base = others.findLastIndex(entry => entry.startsWith('@deepseek-ai/')) + 1
    const ordered = [...others.slice(0, base), name, ...others.slice(base)]
    if (ordered.join('\n') !== profile.bundles.join('\n')) { profile.bundles = ordered; changed = true }
    // `link:` keeps pnpm from copying the generated bundle when it installs other plugins.
    const dependency = 'link:' + bundle.replaceAll('\\', '/')
    if (manifest.dependencies?.[name] !== dependency) {
      manifest.dependencies = { ...manifest.dependencies, [name]: dependency }
      changed = true
    }
    if (changed) await writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
  }, { waitMs: 30000 })
}
