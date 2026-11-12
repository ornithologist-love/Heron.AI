// Optional packages contribute deployment data before providers and profiles
// are composed. The public payload only supplies neutral defaults.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bundledPluginSelection } from './bundled-plugins.mjs'

const content = new URL('./content/', import.meta.url)
const hostRoot = fileURLToPath(new URL('../', import.meta.url))
export const contentSources = new Map()
export const enabledProductPackages = new Map()
let initializedState
const names = new Set(['product.json', 'provider-catalog.json', 'mcp-config.json'])
const json = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
const optionalJson = file => { try { return json(file) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error } }

export function registerContentSource({ id, root, files }) {
  if (typeof id !== 'string' || !id || !path.isAbsolute(root) || !files || typeof files !== 'object' || Array.isArray(files))
    throw Error('Invalid product content source')
  root = path.resolve(root)
  const resolved = {}
  for (const [name, relative] of Object.entries(files)) {
    if (!names.has(name) || typeof relative !== 'string') throw Error('Unsupported product content document')
    const file = path.resolve(root, relative), below = path.relative(root, file)
    if (!below || below.startsWith('..') || path.isAbsolute(below)) throw Error('Product content must stay inside its package')
    for (let current = file; current !== root; current = path.dirname(current))
      if (fs.lstatSync(current).isSymbolicLink()) throw Error('Product content cannot use symbolic links')
    json(file)
    resolved[name] = file
  }
  const previous = contentSources.get(id)
  if (previous && JSON.stringify(previous) !== JSON.stringify(resolved)) throw Error('Conflicting product content source: ' + id)
  contentSources.set(id, resolved)
  return () => { if (contentSources.get(id) === resolved) contentSources.delete(id) }
}

// The same active-bundle selection used by the native web profile: newly
// shipped bundles default on once; an explicit disable remains disabled.
export function initializeProductContent({ stateDir } = {}) {
  stateDir ??= path.join(os.homedir(), '.heron-ai')
  stateDir = path.resolve(stateDir)
  if (initializedState === stateDir) return
  initializedState = stateDir
  contentSources.clear()
  enabledProductPackages.clear()
  const profileRoot = path.join(stateDir, 'dsh', 'profiles', 'web')
  const profile = optionalJson(path.join(profileRoot, 'package.json'))
  const shipped = optionalJson(new URL('bundled-plugins.json', content)) ?? []
  const enabled = bundledPluginSelection(profile, shipped).bundles
  for (const name of enabled) {
    let manifestFile
    try { manifestFile = createRequire(path.join(profileRoot, 'package.json')).resolve(name + '/package.json') }
    catch { try { manifestFile = createRequire(path.join(hostRoot, 'package.json')).resolve(name + '/package.json') } catch { continue } }
    const manifest = json(manifestFile)
    enabledProductPackages.set(manifest.name, { root: path.dirname(manifestFile), manifest })
    if (manifest.heronAi?.content) registerContentSource({ id: manifest.name, root: path.dirname(manifestFile), files: manifest.heronAi.content })
  }
  for (const key of Object.keys(productProfile)) delete productProfile[key]
  Object.assign(productProfile, readContent('product.json') ?? {})
  productProfileFile = pathToFileURL(contentFile('product.json'))
}

export function contentLaunchOptions(argv) {
  const configFile = argv[argv.indexOf('--config') + 1]
  const configured = argv.includes('--config') ? json(path.resolve(configFile)) : {}
  const base = argv.includes('--config') ? path.dirname(path.resolve(configFile)) : process.cwd()
  return { stateDir: argv.includes('--state-dir') ? path.resolve(base, argv[argv.indexOf('--state-dir') + 1])
    : configured.stateDir ? path.resolve(base, configured.stateDir) : undefined }
}

function contentFile(name) {
  const contributors = [...contentSources.values()].map(files => files[name]).filter(Boolean)
  if (contributors.length > 1) throw Error('Multiple packages contribute ' + name)
  return contributors[0] ?? fileURLToPath(new URL(name, content))
}

function resolveMcpTokens(value) {
  let secrets
  for (const server of Object.values(value.mcpServers ?? {})) {
    if (!server.bearerTokenEnv) continue
    const variable = server.bearerTokenEnv
    if (typeof variable !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(variable)) throw Error('Invalid MCP credential reference')
    if (!process.env[variable] && secrets === undefined)
      secrets = optionalJson(process.env.HERON_AI_MCP_SECRETS_FILE ?? path.join(os.homedir(), '.heron-ai', 'build-secrets', 'mcp.json')) ?? {}
    const token = process.env[variable] ?? secrets?.[variable]
    if (typeof token !== 'string' || !token || Buffer.byteLength(token) > 512 || /[\s\x00-\x1f\x7f]/u.test(token)) throw Error('Missing MCP credential: ' + variable)
    server.bearerToken = token
    delete server.bearerTokenEnv
  }
  return value
}

/**
 * Read one JSON document of the payload's deployment content.
 * @param {string} name file name below heron-ai/content
 * @returns {any} the parsed document, or undefined when the payload does not carry it
 */
export function readContent(name) {
  if (name !== 'mcp-config.json') return optionalJson(contentFile(name))
  const value = optionalJson(new URL(name, content)) ?? { version: '1', mcpServers: {} }
  for (const files of contentSources.values()) {
    if (!files[name]) continue
    for (const [id, server] of Object.entries(json(files[name]).mcpServers ?? {})) {
      if (Object.hasOwn(value.mcpServers, id)) throw Error('Duplicate contributed MCP server: ' + id)
      value.mcpServers[id] = server
    }
  }
  return resolveMcpTokens(value)
}

export function readMcpConfiguration(options) {
  const builtin = fileURLToPath(new URL('mcp-config.json', content))
  return options.mcpConfigFile && path.resolve(options.mcpConfigFile) !== builtin
    ? resolveMcpTokens(json(options.mcpConfigFile)) : readContent('mcp-config.json')
}

/** @type {{ serverUrl?: string, collectionWrappingKey?: string, retiredProviders?: string[] }} */
export const productProfile = readContent('product.json') ?? {}

/** Absolute path of the product profile, for plugins that read it themselves. */
export let productProfileFile = new URL('product.json', content)
