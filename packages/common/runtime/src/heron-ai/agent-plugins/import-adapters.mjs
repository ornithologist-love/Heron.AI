import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { validateHeaderName, validateHeaderValue } from 'node:http'
import { isIPv4 } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { MCP_SCHEMA, PLUGIN_SCHEMA, readAgentPluginManifest } from './manifest.mjs'
import { AgentPluginImportError, copyAgentPluginDirectory, createAgentPluginFileBudget, isSafeAgentPluginPath } from './import-files.mjs'

const sourceTypes = new Set(['codex', 'claude-code', 'antigravity'])
const maxConfigBytes = 2 * 1024 * 1024
const privateFile = /^(?:\.env(?:\.|$)|\.(?:git|netrc|npmrc)$|node_modules$|(?:credentials?|secrets?|tokens?)(?:\.|$)|id_(?:rsa|ed25519)(?:\.|$))|\.(?:pem|key|pfx|p12|keystore)$/i
const binaryFile = /\.(?:exe|dll|com|so|dylib|node|jar|class|wasm|a|lib|o|obj|pyd|pyc|apk|7z|zip|gz|tar|bin)$/i
const secretKey = key => /(?:token|secret|apikey|password|authorization|cookie|credential|privatekey|^auth$)/i.test(key.replace(/[^A-Za-z0-9]/g, ''))
const placeholder = /\$\{[^{}]*\}/g
const credentialArg = /^--?(?:[A-Za-z0-9_-]*(?:token|secret|password|api[_-]?key|authorization|credential))(?:=|$)/i
const secretValue = /(?:\bBearer\s+\S+|\b(?:gh[pousr]_|github_pat_|sk-(?:proj-)?|xox[baprs]-)[A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{8,})/i
const packageControls = new Set([
  'plugin.json', 'mcp.json', '.mcp.json', 'mcp_config.json', 'config.toml', 'auth.json',
  'settings.json', 'settings.local.json', 'hooks.json', 'hooks/hooks.json',
])
const stdioFields = new Set(['type', 'command', 'args', 'env', 'cwd'])
const httpFields = new Set(['type', 'url', 'headers'])
const identityFields = ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords']
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value, key) => object(value) && Object.hasOwn(value, key) ? value[key] : undefined
const fail = message => { throw new AgentPluginImportError(message) }
const below = (root, file) => {
  const relative = path.relative(root, file)
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

async function info(file) {
  try { return await lstat(file) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}

/** Inspect every path component so profile manifests cannot refer through links. */
async function localEntry(root, relative) {
  if (!isSafeAgentPluginPath(relative)) fail('A plugin configuration points outside its directory.')
  let next = root
  let metadata
  const parts = relative.split('/')
  for (const [index, part] of parts.entries()) {
    next = path.join(next, part)
    metadata = await info(next)
    if (!metadata) return
    if (metadata.isSymbolicLink()) fail('Plugin import does not follow filesystem links.')
    if (index < parts.length - 1 && !metadata.isDirectory()) fail('A plugin configuration parent is not a directory.')
  }
  return { path: next, info: metadata }
}

async function readConfig(root, relative, parse = JSON.parse) {
  const file = await localEntry(root, relative)
  if (!file) return
  if (!file.info.isFile() || file.info.size > maxConfigBytes) fail(relative + ' must be a regular configuration file under 2 MiB.')
  let value
  try { value = parse((await readFile(file.path, 'utf8')).replace(/^\uFEFF/, '')) }
  catch { fail(relative + (parse === parseToml ? ' is not valid TOML.' : ' is not valid JSON.')) }
  if (!object(value)) fail(relative + ' must contain an object.')
  return value
}

async function immediateDirectories(root) {
  const rootInfo = await info(root)
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) return []
  return (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
    .map(entry => path.join(root, entry.name)).sort()
}

async function candidateRows(source, homeDir) {
  if (!sourceTypes.has(source)) fail('Unknown Agent Plugin source.')
  if (source === 'codex') {
    const profile = await localEntry(homeDir, '.codex')
    if (!profile?.info.isDirectory()) return []
    const directory = profile.path
    const config = await localEntry(directory, 'config.toml')
    const skills = await localEntry(directory, 'skills')
    return config?.info.isFile() || skills?.info.isDirectory() ? [{ id: 'codex-local', name: 'Codex', directory, source }] : []
  }

  const profile = await localEntry(homeDir, source === 'claude-code' ? '.claude/plugins' : '.gemini/config/plugins')
  if (!profile?.info.isDirectory()) return []
  const base = profile.path
  // The package manager's installed index avoids choosing obsolete versions
  // that remain in the Claude cache. Unpacked packages are also recognized.
  const directories = new Set(await immediateDirectories(base))
  if (source === 'claude-code') {
    const index = await readConfig(base, 'installed_plugins.json')
    for (const installations of Object.values(index?.plugins ?? {})) {
      if (!Array.isArray(installations)) continue
      for (const installation of installations) {
        const installPath = installation?.installPath
        if (typeof installPath !== 'string' || !path.isAbsolute(installPath) || !below(base, installPath)) continue
        const candidate = await localEntry(base, path.relative(base, installPath).split(path.sep).join('/')).catch(() => undefined)
        if (candidate?.info.isDirectory()) directories.add(candidate.path)
      }
    }
  }

  const rows = []
  for (const directory of directories) {
    try {
      const file = source === 'claude-code' ? '.claude-plugin/plugin.json' : '.antigravity-plugin/plugin.json'
      const manifest = await readConfig(directory, file)
        ?? (source === 'antigravity' ? await readConfig(directory, 'plugin.json') : undefined)
      const standalone = source === 'antigravity' && (await localEntry(directory, 'skills') || await localEntry(directory, 'mcp_config.json'))
      if (!manifest && !standalone) continue
      const label = typeof manifest?.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(manifest.name)
        ? manifest.name : path.basename(directory)
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(label)) continue
      rows.push({ id: createHash('sha256').update(directory).digest('hex').slice(0, 24), name: label, directory, source })
    } catch (error) {
      // Keep corrupt candidate manifests visible so a preview shows why they fail.
      if (!(error instanceof AgentPluginImportError)) throw error
      const name = path.basename(directory)
      if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(name)) {
        rows.push({ id: createHash('sha256').update(directory).digest('hex').slice(0, 24), name, directory, source })
      }
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}

export async function discoverAgentPluginCandidates(source, { homeDir = os.homedir() } = {}) {
  return (await candidateRows(source, homeDir)).map(({ id, name }) => ({ id, name }))
}

export async function resolveAgentPluginCandidate(source, id, { homeDir = os.homedir() } = {}) {
  const candidate = (await candidateRows(source, homeDir)).find(row => row.id === id)
  if (!candidate) fail('The discovered plugin is no longer available.')
  return { directory: candidate.directory, source: candidate.source }
}

function safeNativeName(value) {
  if (typeof value !== 'string') fail('The plugin manifest is missing a name.')
  const name = value.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/[-.]{2,}/g, '-').replace(/^[.-]+|[.-]+$/g, '')
  if (!name || name.length > 64 || !isSafeAgentPluginPath(name)) fail('The plugin has an invalid name.')
  return name
}

function cloneFields(value, fields) {
  return Object.fromEntries(fields.filter(key => own(value, key) !== undefined).map(key => [key, value[key]]))
}

function cleanEndpoint(value, standard) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || value.trim() !== value
    || value.includes('#') || /\$\{/.test(value)) {
    fail('An MCP endpoint must be an absolute HTTP(S) URL without a fragment or variables.')
  }
  let url
  try { url = new URL(value) } catch { fail('An MCP endpoint is not a valid URL.') }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]'
    || (isIPv4(url.hostname) && url.hostname.startsWith('127.'))
  if (url.protocol === 'http:' && !loopback) {
    if (standard) fail('A standard MCP endpoint must use HTTPS outside loopback.')
    return { unavailable: 'HTTPS is required outside loopback.' }
  }
  let stripped = Boolean(url.username || url.password)
  if (stripped && standard) fail('A standard MCP URL cannot include a username or password.')
  url.username = ''
  url.password = ''
  for (const key of [...url.searchParams.keys()]) {
    if (secretKey(key) || secretValue.test(url.searchParams.get(key))) {
      url.searchParams.delete(key)
      stripped = true
    }
  }
  if (secretValue.test(url.pathname)) fail('An MCP endpoint appears to contain a credential.')
  return { url: stripped ? url.href : value, stripped }
}

function strings(value) {
  return object(value) && Object.values(value).every(item => typeof item === 'string')
}

function replaceClaudePaths(value) {
  return typeof value === 'string' ? value.replace(/\$\{CLAUDE_PLUGIN_(ROOT|DATA)\}/g, (_, name) => '$' + '{PLUGIN_' + name + '}') : value
}

function pathVariable(name) { return '$' + '{PLUGIN_' + name + '}' }

function portableStdio(raw, format) {
  const standard = format === 'standard'
  let { command } = raw
  const { args = [], env = {}, cwd } = raw
  if (typeof command !== 'string' || !command || !Array.isArray(args)
    || !args.every(arg => typeof arg === 'string') || !strings(env)
    || (cwd !== undefined && typeof cwd !== 'string')) fail('A stdio declaration has an invalid command, args, env or cwd.')
  if (format === 'claude-code') command = replaceClaudePaths(command)
  if (!standard && command.startsWith(pathVariable('ROOT') + '/')) command = './' + command.slice(pathVariable('ROOT').length + 1)
  if (!/^[A-Za-z0-9_.-]+$/.test(command) && !command.startsWith('./')) {
    if (standard) fail('A stdio command must be a bare executable or a plugin-relative path.')
    return { unavailable: 'Its local executable is outside the portable package.' }
  }
  if (command === '.' || command === '..' || (command.startsWith('./') && !isSafeAgentPluginPath(command.slice(2)))) {
    fail('A stdio command has an invalid package-relative path.')
  }
  const values = args.map(arg => format === 'claude-code' ? replaceClaudePaths(arg) : arg)
  if (values.some(arg => credentialArg.test(arg) || secretValue.test(arg))) {
    if (standard) fail('Remove credential arguments from the stdio command before importing.')
    return { unavailable: 'Its command arguments may include credentials.' }
  }
  if ([command, ...values].some(value => value.includes('\0'))) fail('A stdio command or argument contains an invalid character.')
  const working = format === 'claude-code' ? replaceClaudePaths(cwd) : cwd
  if (working !== undefined) {
    const relative = working.startsWith('./') ? working.slice(2)
      : [pathVariable('ROOT'), pathVariable('DATA')].find(prefix => working === prefix || working.startsWith(prefix + '/'))
    if (relative === undefined) {
      if (standard) fail('A stdio working directory must be inside the package or its managed data.')
      return { unavailable: 'Its working directory is outside the portable package.' }
    }
    const suffix = working.startsWith('./') ? relative : working.slice(relative.length + 1)
    if (suffix && !isSafeAgentPluginPath(suffix)) fail('A stdio working directory escapes the portable package.')
  }
  if (values.some(arg => (arg.match(placeholder) ?? []).some(value => ![pathVariable('ROOT'), pathVariable('DATA')].includes(value)))) {
    if (standard) fail('Only plugin-root and data placeholders can be used in stdio arguments.')
    return { unavailable: 'Its command arguments require client-specific variables.' }
  }
  if (raw.env_vars !== undefined && (!Array.isArray(raw.env_vars) || !raw.env_vars.every(item => typeof item === 'string'))) {
    fail('A stdio env_vars declaration is invalid.')
  }
  let stripped = Boolean(raw.env_vars?.length || raw.variables?.length)
  const clean = Object.fromEntries(Object.entries(env).flatMap(([key, input]) => {
    const value = format === 'claude-code' ? replaceClaudePaths(input) : input
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /^PLUGIN_(ROOT|DATA)$/i.test(key)) fail('A stdio environment name is invalid or reserved.')
    if (secretKey(key) || secretValue.test(value) || (value.match(placeholder) ?? []).some(part => ![pathVariable('ROOT'), pathVariable('DATA')].includes(part))) {
      stripped = true
      return []
    }
    return [[key, value]]
  }))
  return {
    spec: { type: 'stdio', command, ...(raw.args === undefined ? {} : { args: values }),
      ...(Object.keys(clean).length ? { env: clean } : {}), ...(working === undefined ? {} : { cwd: working }) },
    stripped,
  }
}


function portableHttp(raw, format, type) {
  const endpoint = cleanEndpoint(raw.url ?? raw.serverUrl, format === 'standard')
  if (endpoint.unavailable) return endpoint
  const headers = raw.headers !== undefined ? raw.headers : (raw.http_headers ?? {})
  if (!strings(headers)) fail('An MCP declaration has invalid HTTP headers.')
  let stripped = Boolean(endpoint.stripped || raw.bearer_token_env_var
    || Object.keys(raw.env_http_headers ?? {}).length || raw.variables?.length || raw.headersHelper || raw.http_headers_helper)
  const seen = new Set()
  const clean = Object.fromEntries(Object.entries(headers).flatMap(([key, value]) => {
    const folded = key.toLowerCase()
    if (seen.has(folded)) fail('An MCP declaration repeats an HTTP header.')
    seen.add(folded)
    try { validateHeaderName(key); validateHeaderValue(key, value) }
    catch { fail('An MCP declaration has an invalid HTTP header.') }
    if (secretKey(key) || secretValue.test(value) || /\$\{/.test(value)) {
      stripped = true
      return []
    }
    return [[key, value]]
  }))
  const oauth = object(raw.oauth) || raw.auth === 'oauth'
  return { spec: { type, url: endpoint.url, ...(Object.keys(clean).length ? { headers: clean } : {}) }, stripped, oauth }
}

function normalizeServer(raw, format) {
  if (!object(raw)) fail('An MCP server declaration must be an object.')
  const type = raw.type === 'http' ? 'streamable-http'
    : raw.type ?? (raw.command !== undefined ? 'stdio' : 'streamable-http')
  if (format === 'standard') {
    const allowed = type === 'stdio' ? stdioFields : httpFields
    if (raw.type !== type || Object.keys(raw).some(key => !allowed.has(key))) {
      fail('A standard MCP server has invalid or unknown fields.')
    }
  } else if (raw.command !== undefined && (raw.url !== undefined || raw.serverUrl !== undefined)) {
    fail('An MCP server cannot declare both a command and an HTTP endpoint.')
  }
  if (type === 'stdio') return portableStdio(raw, format)
  if (type === 'sse' || type === 'streamable-http') return portableHttp(raw, format, type)
  if (format !== 'standard') return { unavailable: 'Its MCP transport is not supported in Heron.AI.' }
  fail('A standard MCP server has an invalid transport.')
}

function serverMap(config, { field = 'mcpServers', direct = false } = {}) {
  if (!config) return {}
  const servers = own(config, field) ?? (direct ? config : undefined)
  if (!object(servers)) fail('The MCP configuration must contain a server object.')
  return servers
}

async function nativeServerConfig(root, manifest, format) {
  if (format === 'codex') {
    const config = await readConfig(root, 'config.toml', parseToml)
    if (config) return own(config, 'mcp_servers') === undefined ? {} : serverMap(config, { field: 'mcp_servers' })
    return serverMap(await readConfig(root, '.mcp.json'), { direct: true })
  }
  if (format === 'antigravity') return serverMap(await readConfig(root, 'mcp_config.json'))
  const config = serverMap(await readConfig(root, '.mcp.json'), { direct: true })
  const source = own(manifest, 'mcpServers')
  if (source === undefined) return config
  const assets = Array.isArray(source) ? source : [source]
  for (const entry of assets) {
    let overlay = entry
    if (typeof entry === 'string') {
      if (!entry.startsWith('./') || !isSafeAgentPluginPath(entry.slice(2)) || !/\.json$/i.test(entry)) {
        fail('Claude Code MCP overlays must be package-relative JSON files.')
      }
      overlay = await readConfig(root, entry.slice(2))
      if (!overlay) fail('A declared Claude Code MCP file is missing.')
    }
    Object.assign(config, serverMap(overlay, { direct: true }))
  }
  return config
}

function safePresentation(value) {
  return cloneFields(value, ['title', 'description', 'icon'])
}

function convertedManifests(manifest, standard, native, format, warnings) {
  const identity = cloneFields(manifest, identityFields)
  if (format !== 'standard') identity.name = safeNativeName(identity.name
    ?? { codex: 'codex-local', 'claude-code': 'claude-plugin', antigravity: 'antigravity-plugin' }[format])
  const heron = own(manifest?.extensions, 'io.heron-ai')
  const presentations = own(heron, 'servers')
  if (heron !== undefined && !object(heron)) fail('The io.heron-ai plugin extension must be an object.')
  if (presentations !== undefined && !object(presentations)) fail('The io.heron-ai MCP presentation must be an object.')
  const servers = Object.create(null)
  const serverMetadata = Object.create(null)
  for (const key of new Set([...Object.keys(standard), ...Object.keys(native)])) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(key) || secretValue.test(key)) {
      fail('An MCP service has an invalid name.')
    }
    const hasStandard = Object.hasOwn(standard, key)
    const raw = hasStandard ? standard[key] : native[key]
    let converted
    try { converted = normalizeServer(raw, hasStandard ? 'standard' : format) }
    catch (error) {
      if (error instanceof AgentPluginImportError) fail('MCP ' + key + ' — ' + error.message)
      throw error
    }
    if (converted.unavailable) {
      warnings.push('MCP ' + key + ' was skipped. ' + converted.unavailable)
      continue
    }
    const metadata = cloneFields(own(presentations, key), ['title', 'description', 'displayName', 'authType', 'scopes', 'enabled'])
    if (converted.oauth && !metadata.authType) metadata.authType = 'oauth'
    // A Codex export carries a portable configuration beside its TOML. The
    // latter can declare authentication references absent from the standard.
    const companion = hasStandard ? own(native, key) : undefined
    const localCredentials = companion?.bearer_token_env_var || Object.keys(companion?.env_http_headers ?? {}).length
    if (converted.stripped || localCredentials) {
      if (metadata.authType !== 'oauth') metadata.enabled = false
      warnings.push('MCP ' + key + ' requires local credential setup. Source credentials and variable values were omitted.')
    }
    if (raw.enabled === false) metadata.enabled = false
    servers[key] = converted.spec
    if (Object.keys(metadata).length) serverMetadata[key] = metadata
  }

  if (object(presentations) && Object.keys(presentations).some(key => !Object.hasOwn(servers, key) && own(presentations[key], 'existingId'))) {
    warnings.push('This plugin references services from its original host. Only self-contained MCP declarations are imported.')
  }
  const extension = safePresentation(heron)
  if (own(heron, 'cards') !== undefined) {
    if (!Array.isArray(heron.cards)) fail('Plugin connector cards must be an array.')
    extension.cards = heron.cards.map(card => {
      if (!object(card) || !Array.isArray(card.servers) || !card.servers.every(key => typeof key === 'string')) {
        fail('A plugin connector card is invalid.')
      }
      return { ...safePresentation(card), id: card.id, servers: card.servers.filter(key => Object.hasOwn(servers, key)) }
    })
  }
  if (Object.keys(serverMetadata).length) extension.servers = serverMetadata
  return {
    plugin: { $schema: PLUGIN_SCHEMA, ...identity, ...(Object.keys(extension).length ? { extensions: { 'io.heron-ai': extension } } : {}) },
    mcp: { $schema: MCP_SCHEMA, mcpServers: servers },
  }
}

async function recognize(root, selected) {
  if (selected && !sourceTypes.has(selected)) fail('Unknown Agent Plugin source.')
  const standard = await readConfig(root, 'plugin.json')
  const portable = standard?.$schema === PLUGIN_SCHEMA
  if (selected === 'codex' || (!selected && (await localEntry(root, 'config.toml') || await localEntry(root, '.codex-plugin/plugin.json')))) {
    const manifest = (portable ? standard : await readConfig(root, '.codex-plugin/plugin.json')) ?? {}
    return { format: 'codex', portable, manifest }
  }
  if (portable) return { format: 'standard', portable, manifest: standard }
  const claude = selected === 'claude-code' || !selected ? await readConfig(root, '.claude-plugin/plugin.json') : undefined
  if (claude) return { format: 'claude-code', portable: false, manifest: claude }
  const antigravity = selected === 'antigravity' || !selected ? await readConfig(root, '.antigravity-plugin/plugin.json') : undefined
  const standalone = !selected && (await localEntry(root, 'mcp_config.json')
    || (standard && standard.$schema === undefined && !await localEntry(root, 'mcp.json') && await localEntry(root, 'skills')))
  if (antigravity || selected === 'antigravity' || standalone) {
    return { format: 'antigravity', portable: false, manifest: antigravity ?? standard ?? { name: path.basename(root) } }
  }
  if (standard) fail('plugin.json has an unsupported schema. Use Agent Plugins 1.0.0.')
  fail('This directory does not contain a supported Agent Plugin or Codex configuration.')
}

function standardServerConfig(value) {
  if (!value) return {}
  if (value.$schema !== MCP_SCHEMA || Object.keys(value).some(key => !['$schema', 'mcpServers'].includes(key))) {
    fail('mcp.json must follow the Agent Plugins 1.0.0 schema.')
  }
  return serverMap(value)
}

async function privateBinary(file) {
  if (binaryFile.test(file)) return true
  const handle = await open(file, 'r')
  try {
    const bytes = Buffer.alloc(1024)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    const data = bytes.subarray(0, bytesRead)
    if (/^(?:png|gif|jpe?g|webp|woff2?|pdf)$/i.test(path.extname(file).slice(1))) {
      return !(data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
        || /^(?:GIF8[79]a|%PDF-)/.test(data.toString('latin1'))
        || data.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
        || (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP')
        || ['wOFF', 'wOF2'].includes(data.subarray(0, 4).toString()))
    }
    return data.includes(0) || data.subarray(0, 2).toString() === 'MZ'
  } finally { await handle.close() }
}

async function copyContent(root, destination, { format, manifest, wholePackage, warnings }) {
  const budget = createAgentPluginFileBudget()
  const controls = new Set(packageControls)
  if (format === 'claude-code') {
    const overlays = Array.isArray(manifest.mcpServers) ? manifest.mcpServers : [manifest.mcpServers]
    for (const item of overlays) if (typeof item === 'string' && item.startsWith('./')) controls.add(item.slice(2).toLowerCase())
  }
  let omittedBinary = false
  const filter = async (relative, directory, file) => {
    const folded = relative.toLowerCase()
    if (controls.has(folded) || relative.split('/').some(part => part.startsWith('.') || privateFile.test(part))) return false
    if (format === 'antigravity' && (folded === 'bin' || !directory && await privateBinary(file))) {
      omittedBinary = true
      return false
    }
    return true
  }
  if (wholePackage) await copyAgentPluginDirectory(root, destination, { budget, filter })
  else {
    for (const name of ['skills', 'assets', 'scripts', 'bin']) {
      const item = await localEntry(root, name)
      if (!item) continue
      if (!item.info.isDirectory()) fail(name + ' must be a directory.')
      if (!await filter(name, true, item.path)) continue
      await copyAgentPluginDirectory(item.path, path.join(destination, name), {
        budget,
        filter: (relative, directory, file) => filter(name + '/' + relative, directory, file),
      })
    }
  }
  if (omittedBinary) warnings.push('Antigravity binary files were skipped. Only portable plugin files can be imported.')
}

async function checkSkillEntries(destination) {
  const skills = await localEntry(destination, 'skills')
  if (!skills) return
  for (const skill of await immediateDirectories(skills.path)) {
    if (!(await localEntry(skill, 'SKILL.md'))?.info.isFile()) {
      fail('A skill folder is missing its SKILL.md file.')
    }
  }
}

/** Normalize one locally selected or already safely extracted source without executing it. */
export async function normalizeAgentPluginSource(directory, destination, options = {}) {
  const { source } = options
  const entry = await info(directory)
  if (!entry?.isDirectory() || entry.isSymbolicLink()) fail('The selected Agent Plugin is not a regular directory.')
  const root = await realpath(directory)
  const { format, portable, manifest } = await recognize(root, source, options)
  if (portable) {
    try { await readAgentPluginManifest(root) }
    catch { fail('The standard plugin.json is invalid. Check its name, metadata and schema version.') }
  }

  const warnings = []
  const standard = portable ? standardServerConfig(await readConfig(root, 'mcp.json')) : {}
  const native = format === 'standard' ? {} : await nativeServerConfig(root, manifest, format)
  if (format !== 'standard' && (manifest.hooks || manifest.agents || manifest.rules || manifest.commands)) {
    warnings.push('Only MCP servers and skills are imported. Client-specific hooks and rules are ignored.')
  }
  const { plugin, mcp } = convertedManifests(manifest, standard, native, format, warnings)
  await mkdir(destination, { recursive: true })
  await copyContent(root, destination, {
    format, manifest, warnings,
    wholePackage: !source && (portable || format !== 'codex'),
  })
  await checkSkillEntries(destination)
  if (format === 'antigravity') {
    for (const [key, server] of Object.entries(mcp.mcpServers)) {
      if (server.type !== 'stdio' || !server.command.startsWith('./')) continue
      const command = await localEntry(destination, server.command.slice(2))
      if (command?.info.isFile()) continue
      delete mcp.mcpServers[key]
      if (plugin.extensions?.['io.heron-ai']?.servers) delete plugin.extensions['io.heron-ai'].servers[key]
      for (const card of plugin.extensions?.['io.heron-ai']?.cards ?? []) card.servers = card.servers.filter(id => id !== key)
      warnings.push('MCP ' + key + ' was skipped because its executable was unavailable in the portable package.')
    }
  }
  await writeFile(path.join(destination, 'plugin.json'), JSON.stringify(plugin, null, 2) + '\n', { flag: 'wx' })
  await writeFile(path.join(destination, 'mcp.json'), JSON.stringify(mcp, null, 2) + '\n', { flag: 'wx' })
  return { format, warnings }
}
