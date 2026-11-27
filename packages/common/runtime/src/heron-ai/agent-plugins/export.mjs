import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { isIPv4 } from 'node:net'
import path from 'node:path'
import { zipSync } from 'fflate'
import { MCP_SCHEMA, PLUGIN_SCHEMA, readAgentPluginManifest, readAgentSkill } from './manifest.mjs'

export const AGENT_PLUGIN_EXPORT_FORMATS = Object.freeze(['standard', 'claude-code', 'codex', 'antigravity'])

class AgentPluginExportError extends Error {
  name = 'AgentPluginExportError'
}

const invalidPath = /[<>:"\\|?*\x00-\x1f]|[. ]$|^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i
const privateFile = /^(?:\.env(?:\.|$)|\.npmrc$|\.netrc$|\.git$|node_modules$|(?:credentials?|secrets?|tokens?)(?:\.|$)|id_(?:rsa|ed25519)(?:\.|$))|\.(?:pem|key|pfx|p12|keystore)$/i
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/
const secretField = key => /^(?:authorization|cookie|setcookie|[a-z0-9]*(?:password|secret|token|apikey))$/.test(key.toLowerCase().replace(/[^a-z0-9]/g, ''))
const knownSecret = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|sk-(?:proj-)?[a-z0-9_-]{20,}|xox[baprs]-[a-z0-9-]{12,}|AIza[a-z0-9_-]{30,}|AKIA[A-Z0-9]{16})\b|\beyJ[a-zA-Z0-9_-]{6,}\.eyJ[a-zA-Z0-9_-]{6,}\.[a-zA-Z0-9_-]{8,}/i
const assignment = /(?:^|[\s{,;])["']?([a-zA-Z][\w.-]*)["']?\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,;}"'<>]+))/gm
const example = /^(?:\$\{[\w.]+\}|\$env:[\w]+|\$[\w]+|\.{3}|<[^>]+>|(?:your|example|placeholder|redacted|dummy|replace[_-]?me)(?:[_-][\w-]+)?)$/i
const maxSize = 32 * 1024 * 1024
const utf8 = new TextDecoder('utf8', { fatal: true })
const gb18030 = new TextDecoder('gb18030', { fatal: true })
const portableMcpScript = 'scripts/portable-mcp-stdio.mjs'
const portableMcpConfig = 'scripts/portable-mcp-servers.json'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const placeholder = name => '$' + '{' + name + '}'
const variablePart = value => value.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
const fail = message => { throw new AgentPluginExportError(message) }

function collectSecrets(secrets, source) {
  const add = value => {
    if (typeof value !== 'string') return
    value = value.replace(/^(?:Bearer|Basic)\s+/i, '')
    if (value.length >= 8 && !example.test(value)) secrets.add(value)
  }
  if (!object(source) && !Array.isArray(source)) return
  for (const [key, value] of Object.entries(source)) {
    if (secretField(key)) add(value)
    if (key === 'headers' && object(value)) Object.values(value).forEach(add)
    if (key === 'url' && typeof value === 'string') {
      try {
        const url = new URL(value)
        add(url.username)
        add(url.password)
        for (const [key, param] of url.searchParams) if (secretField(key)) add(param)
      } catch { /* Endpoint validation runs when projecting the server. */ }
    }
    collectSecrets(secrets, value)
  }
}

function scan(text, secrets, { sourceCode = false, dataFile = false } = {}) {
  const literal = [...text.matchAll(assignment)].some(([, key, double, single, bare]) => {
    if (!secretField(key)) return false
    if (sourceCode && bare && (/^process\.env\.[A-Za-z_][A-Za-z0-9_]*$/.test(bare)
      || (/^\w+\.\w+$/.test(bare) && bare.endsWith('.' + key)))) return false
    const value = (double ?? single ?? bare).replace(/^(?:Bearer|Basic)\s+/i, '')
    return value && !example.test(value) && (dataFile || double !== undefined || single !== undefined || value.length >= 16)
  })
  const bearer = /\bBearer [a-z0-9+/._=-]{12,}\b/i.test(text.replace(/\bBearer (?:YOUR|EXAMPLE)[_-][\w-]+/ig, ''))
  if (literal || bearer || knownSecret.test(text) || [...secrets].some(secret => text.includes(secret))) {
    fail('Export stopped because a file or field contains a possible credential.')
  }
}

async function fileInfo(file) {
  try { return await lstat(file) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}

async function readJson(file) {
  const info = await fileInfo(file)
  if (!info) return
  if (!info.isFile() || info.size > maxSize) fail('A plugin configuration file is not a regular file or is too large.')
  try { return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')) }
  catch { fail('A plugin configuration file is invalid JSON.') }
}

// Read installed declarations. Profile state, merged MCP settings and OAuth
// stores are deliberately outside the export inputs.
async function readBundledServers(hostRoot, ids) {
  if (!hostRoot || !ids.size) return {}
  const content = path.join(hostRoot, 'heron-ai', 'content')
  const configs = [path.join(content, 'mcp-config.json')]
  const packages = await readJson(path.join(content, 'bundled-plugins.json')) ?? []
  if (!Array.isArray(packages)) fail('The installed bundle list is invalid.')
  for (const name of packages) {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(name)) continue
    const root = await realpath(path.join(hostRoot, 'node_modules', name))
    const manifest = await readJson(path.join(root, 'package.json'))
    const relative = manifest?.heronAi?.content?.['mcp-config.json']
    if (typeof relative !== 'string') continue
    const file = await realpath(path.resolve(root, relative))
    const below = path.relative(root, file)
    if (!below || below.startsWith('..') || path.isAbsolute(below)) fail('A bundled MCP declaration escapes its package.')
    configs.push(file)
  }
  const entries = Object.create(null)
  for (const file of configs) {
    const value = await readJson(file)
    for (const [key, spec] of Object.entries(value?.mcpServers ?? {})) {
      if (!ids.has(key)) continue
      if (Object.hasOwn(entries, key)) fail('A referenced MCP service has multiple bundled definitions.')
      entries[key] = spec
    }
  }
  return entries
}

function stdio(key, spec) {
  const { command, args = [], env = {}, cwd } = spec
  if (typeof command !== 'string' || !/^(?:[a-z0-9_-][a-z0-9_.-]*|\.\/[^\x00]+)$/i.test(command)
    || !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || /^--?[\w-]+/.test(arg) && secretField(arg.split('=')[0]))
    || !object(env)
    || (cwd !== undefined && (typeof cwd !== 'string' || !/^(?:\.\/|\$\{PLUGIN_(?:ROOT|DATA)\}(?:\/|$))/.test(cwd)))) {
    fail('A stdio server has unsupported paths or credential arguments. Use environment variables for credentials.')
  }
  const values = Object.fromEntries(Object.entries(env).map(([name, value]) => {
    if (!envName.test(name) || /^PLUGIN_(ROOT|DATA)$/i.test(name) || typeof value !== 'string') {
      fail('A stdio server declares an invalid environment setting.')
    }
    return [name, secretField(name) ? placeholder(name) : value]
  }))
  return { key, type: 'stdio', command, args, env: values, ...(cwd ? { cwd } : {}) }
}

function endpoint(raw) {
  if (typeof raw !== 'string' || !/^https?:\/\//i.test(raw)) fail('An MCP server has an invalid HTTP endpoint.')
  let url
  try { url = new URL(raw) } catch { fail('An MCP server has an invalid HTTP endpoint.') }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]'
    || (isIPv4(url.hostname) && url.hostname.startsWith('127.'))
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  return { url: url.href, portable: url.protocol === 'https:' || loopback }
}

function httpHeaders(name, key, spec, sharedBearer) {
  if (!object(spec.headers ?? {})) fail('An MCP server declares invalid HTTP headers.')
  const headers = Object.entries(spec.headers ?? {}).map(([header, value]) => {
    if (!/^[!#$%&'*+.^_|~0-9a-z-]+$/i.test(header) || typeof value !== 'string') fail('An MCP server declares invalid HTTP headers.')
    const bearer = header.toLowerCase() === 'authorization' && /^Bearer\s+/i.test(value)
    const explicit = /^(?:Bearer )?\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/i.exec(value)?.[1]
    const variable = explicit ?? [name, key, bearer ? 'TOKEN' : header].map(variablePart).join('_')
    return { header, variable, bearer }
  })
  if (!headers.some(row => row.header.toLowerCase() === 'authorization') && (spec.auth === 'bearer' || spec.bearerToken || spec.bearerTokenEnv)) {
    const suffix = sharedBearer ? 'MCP_TOKEN' : variablePart(key) + '_MCP_TOKEN'
    const variable = envName.test(spec.bearerTokenEnv ?? '') ? spec.bearerTokenEnv : variablePart(name) + '_' + suffix
    headers.push({ header: 'Authorization', variable, bearer: true })
  }
  return headers
}

function collectServers(name, specs, references, native, secrets) {
  const rows = []
  const omitted = []
  const tokens = new Set(Object.values(native).map(spec => spec?.bearerToken).filter(Boolean))
  for (const key of new Set([...Object.keys(specs), ...Object.keys(references)])) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(key)) fail('An MCP server has an invalid export name.')
    scan(key, secrets)
    const metadata = Object.hasOwn(references, key) ? references[key] : undefined
    const nativeSource = !Object.hasOwn(specs, key) && Object.hasOwn(native, metadata?.existingId)
    const spec = nativeSource ? native[metadata.existingId] : Object.hasOwn(specs, key) ? specs[key] : undefined
    if (!spec) {
      if (metadata?.existingId) omitted.push([key, 'Available only inside the original host or edition.'])
      continue
    }
    if (spec.type === 'stdio') {
      rows.push(stdio(key, spec))
      continue
    }
    const type = nativeSource ? spec.httpTransport ?? 'streamable-http' : spec.type
    if (!['streamable-http', 'sse'].includes(type)) fail('An MCP server has an unsupported transport.')
    const oauth = metadata?.authType === 'oauth' || spec.auth === 'oauth'
    const row = { key, type, ...endpoint(spec.url), oauth, headers: oauth ? [] : httpHeaders(name, key, spec, nativeSource && tokens.size === 1) }
    if (nativeSource && type === 'streamable-http' && !oauth && metadata.includeBearerInExport === true) {
      const token = spec.bearerToken
      if (spec.auth !== 'bearer' || typeof token !== 'string' || token.length > 512 || !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) {
        fail('The bundled MCP service ' + key + ' is missing a valid bearer credential for export.')
      }
      row.bearerToken = token
      row.headers = row.headers.filter(entry => entry.header.toLowerCase() !== 'authorization')
    }
    rows.push(row)
  }
  return { rows, omitted }
}

async function collectFiles(root, secrets) {
  const files = Object.create(null)
  const paths = new Set()
  let size = 0
  async function visit(relative) {
    if (relative.split('/').some(name => invalidPath.test(name))) fail('A plugin file has an unsafe archive path.')
    const filename = path.join(root, ...relative.split('/'))
    const info = await lstat(filename)
    if (!info.isDirectory() && !info.isFile()) fail('Plugin export requires regular files and directories. Remove symbolic links from the package.')
    if (privateFile.test(path.basename(filename))) return
    const folded = relative.normalize('NFC').toLowerCase()
    if (paths.has(folded)) fail('Plugin paths collide on a case-insensitive filesystem.')
    paths.add(folded)
    scan(relative, secrets)
    if (info.isDirectory()) {
      for (const child of (await readdir(filename)).sort()) await visit(relative + '/' + child)
      return
    }
    if (size + info.size > maxSize) fail('Plugin files exceed the supported export size.')
    const bytes = await readFile(filename)
    size += bytes.length
    if (size > maxSize) fail('Plugin files exceed the supported export size.')
    let content = bytes
    let text
    try { text = utf8.decode(bytes) }
    catch {
      // Older Chinese Markdown references may still use Windows code page 936.
      if (/\.md$/i.test(relative)) {
        try { text = gb18030.decode(bytes); content = Buffer.from(text) } catch { /* Report unreadable content below. */ }
      }
    }
    if (text === undefined || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
      fail('A skill or script contains binary data that cannot be checked for credentials.')
    }
    scan(text, secrets, {
      sourceCode: /\.[cm]?[jt]sx?$/i.test(relative),
      dataFile: /\.(?:json|ya?ml|toml)$/i.test(relative),
    })
    files[relative] = [content, { attrs: ((0o100644 | (info.mode & 0o111)) << 16) >>> 0, os: 3 }]
  }

  const skills = []
  const skillPath = path.join(root, 'skills')
  const skillInfo = await fileInfo(skillPath)
  if (skillInfo) {
    if (!skillInfo.isDirectory()) fail('The skills folder must be a regular directory.')
    for (const child of (await readdir(skillPath, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (child.isSymbolicLink()) fail('Plugin export requires regular skill directories.')
      if (!child.isDirectory() || privateFile.test(child.name) || !await fileInfo(path.join(skillPath, child.name, 'SKILL.md'))) continue
      await visit('skills/' + child.name)
      try { await readAgentSkill(root, child.name) } catch { fail('A skill has invalid SKILL.md metadata.') }
      skills.push(child.name)
    }
  }
  for (const name of ['scripts', 'bin']) if (await fileInfo(path.join(root, name))) await visit(name)
  return { files, skills, paths }
}


function standardServer({ key, portable, oauth, headers, ...row }) {
  if (row.bearerToken) return { type: 'stdio', command: 'node', args: [placeholder('PLUGIN_ROOT') + '/' + portableMcpScript, key] }
  return row
}

function targetServer(row, format) {
  if (row.type === 'stdio') {
    const claude = format === 'claude-code'
    const translate = value => claude ? value.replace(/\$\{PLUGIN_(ROOT|DATA)\}/g, (_, kind) => placeholder('CLAUDE_PLUGIN_' + kind)) : value
    const command = claude && row.command.startsWith('./') ? placeholder('CLAUDE_PLUGIN_ROOT') + row.command.slice(1) : row.command
    const options = { command, args: row.args.map(translate), env: Object.fromEntries(Object.entries(row.env).map(([key, value]) => [key, translate(value)])) }
    if (claude) return { type: 'stdio', ...options }
    const variables = Object.keys(row.env).filter(key => row.env[key] === placeholder(key)).map(name => ({ name }))
    return { ...options, ...(row.cwd ? { cwd: row.cwd } : {}), ...(variables.length ? { variables } : {}) }
  }
  const headers = Object.fromEntries(row.headers.map(({ header, variable, bearer }) => [header, (bearer ? 'Bearer ' : '') + placeholder(variable)]))
  if (row.bearerToken) headers.Authorization = 'Bearer ' + row.bearerToken
  const forwarded = Object.keys(headers).length ? { headers } : {}
  if (format === 'claude-code') return { type: row.type === 'sse' ? 'sse' : 'http', url: row.url, ...forwarded }
  const variables = [...new Set(row.headers.map(entry => entry.variable))].map(name => ({ name }))
  return { serverUrl: row.url, ...forwarded, ...(variables.length ? { variables } : {}) }
}

function codexServer(row) {
  if (row.type === 'stdio') {
    const workingDirectory = row.cwd?.replace(/\$\{PLUGIN_ROOT\}/g, '.') ?? '.'
    const cwd = workingDirectory === '.' ? './' : workingDirectory
    const toRoot = path.posix.relative(cwd, '.') || '.'
    const translate = value => value.replace(/\$\{PLUGIN_ROOT\}/g, toRoot)
    const env = {}
    const envVars = []
    for (const [key, value] of Object.entries(row.env)) {
      if (value === placeholder(key)) envVars.push(key)
      else env[key] = translate(value)
    }
    const relativeCommand = row.command.startsWith('./') ? path.posix.relative(cwd, row.command) : undefined
    const command = relativeCommand === undefined ? row.command : relativeCommand.startsWith('../') ? relativeCommand : './' + relativeCommand
    return {
      command, args: row.args.map(translate), cwd,
      ...(envVars.length ? { env_vars: envVars } : {}),
      ...(Object.keys(env).length ? { env } : {}),
    }
  }
  const bearer = row.headers.find(entry => entry.bearer)
  const headers = row.headers.filter(entry => !entry.bearer)
  return {
    url: row.url,
    ...(row.oauth ? { auth: 'oauth' } : {}),
    ...(row.bearerToken ? { http_headers: { Authorization: 'Bearer ' + row.bearerToken } } : {}),
    ...(bearer ? { bearer_token_env_var: bearer.variable } : {}),
    ...(headers.length ? { env_http_headers: Object.fromEntries(headers.map(entry => [entry.header, entry.variable])) } : {}),
  }
}

// The local catalog points back to the package root, so the same archive can
// be added as a marketplace and also installed as a standalone Codex plugin.
function codexMarketplace(name, title) {
  return {
    name: name + '-local',
    interface: { displayName: title },
    plugins: [{
      name,
      source: { source: 'local', path: './' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_USE' },
      category: 'Productivity',
    }],
  }
}

async function readExportLogo(root, logo, secrets) {
  if (typeof logo !== 'string' || !logo.startsWith('./assets/') || !/\.png$/i.test(logo)) return
  const parts = logo.slice(2).split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || invalidPath.test(part))) return
  let filename = root
  for (const [index, part] of parts.entries()) {
    filename = path.join(filename, part)
    const info = await fileInfo(filename)
    if (index < parts.length - 1 ? !info?.isDirectory() : !info?.isFile() || info.size > 1024 * 1024) return
  }
  const bytes = await readFile(filename)
  if (bytes.length > 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return
  const output = [bytes.subarray(0, 8)]
  let imageData = false
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset)
    const end = offset + length + 12
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    if (end > bytes.length || (offset === 8 && (type !== 'IHDR' || length !== 13))) return
    if (offset === 8 && (bytes.readUInt32BE(offset + 8) > 1024 || bytes.readUInt32BE(offset + 12) > 1024)) return
    // Keep the raster and transparency. Ancillary authoring data stays out.
    if (['IHDR', 'PLTE', 'IDAT', 'tRNS', 'IEND'].includes(type)) output.push(bytes.subarray(offset, end))
    if (type === 'IDAT') imageData = true
    if (type === 'IEND') {
      if (!imageData || length !== 0) return
      const sanitized = Buffer.concat(output)
      scan(sanitized.toString('latin1'), secrets)
      return sanitized
    }
    offset = end
  }
}

function makeReadme(name, format, skills, rows, omitted) {
  const instructions = {
    standard: 'Extract this ZIP into its own folder and import the folder in an Agent Plugins 1.0.0 client. For static credentials, use the client’s local MCP setup. The portable format does not expand environment variables for authentication.',
    'claude-code': 'Run claude --plugin-dir <file.zip>. Set any variables listed below before starting Claude Code.',
    codex: 'Give this ZIP to Codex and ask it to install the plugin. Extract it into a folder you can keep and run codex plugin marketplace add <folder>, then codex plugin add ' + name + '@' + name + '-local. Open a new Codex chat to use the installed plugin.',
    antigravity: 'Extract this ZIP and run agy plugin validate <folder>, then agy plugin install <folder>. Configure the requested variables from Customizations when enabling the plugin.',
  }
  const code = value => String.fromCharCode(96) + value + String.fromCharCode(96)
  const list = entries => entries.length ? entries.map(line => '- ' + line).join('\n') : 'None.'
  return [
    '# ' + name, '## Install', instructions[format],
    ...(format === 'standard' && rows.some(row => row.bearerToken) ? ['Bundled MCP servers with included authentication use stdio and require Node.js 18 or later on PATH.'] : []),
    'OAuth services use the recipient’s own sign-in. Internal endpoints require access to the organization’s network.',
    '## Skills', list(skills.map(code)),
    '## MCP servers', list(rows.map(row => {
      const variables = row.headers ? row.headers.map(entry => entry.variable) : Object.keys(row.env).filter(key => row.env[key] === placeholder(key))
      return code(row.key) + (row.oauth ? ' — sign in using OAuth.' : '')
        + (row.bearerToken ? ' — authentication included.' : '')
        + (variables.length ? ' — configure ' + [...new Set(variables)].map(name => code(placeholder(name))).join(', ') + '.' : '')
    })),
    ...(omitted.length ? ['## Unavailable in this preset', list(omitted.map(([key, reason]) => code(key) + ' — ' + reason))] : []),
    '',
  ].join('\n\n')
}

export async function exportAgentPlugin(directory, { format = 'standard', bundled = false, hostRoot } = {}) {
  if (!AGENT_PLUGIN_EXPORT_FORMATS.includes(format)) fail('Unknown Agent Plugin export format.')
  let info
  try { info = await readAgentPluginManifest(directory, { bundled }) }
  catch { fail('The Agent Plugin manifest is missing or invalid.') }
  const { root, manifest, filename } = info
  if (!(await lstat(path.join(root, filename))).isFile()) fail('Plugin manifest must be a regular file.')
  const config = await readJson(path.join(root, 'mcp.json'))
  if (config && (config.$schema !== MCP_SCHEMA || !object(config.mcpServers))) {
    fail('The MCP configuration must use the Agent Plugins 1.0.0 schema.')
  }
  const specs = config?.mcpServers ?? {}
  const metadata = manifest.extensions?.['io.heron-ai']?.servers
  const references = object(metadata) ? metadata : {}
  const ids = new Set(Object.values(references).filter(row => typeof row?.existingId === 'string').map(row => row.existingId))
  const native = bundled ? await readBundledServers(hostRoot, ids) : {}
  const secrets = new Set()
  for (const source of [manifest, specs, native]) collectSecrets(secrets, source)
  const { rows, omitted } = collectServers(manifest.name, specs, references, native, secrets)
  const { files, skills, paths } = await collectFiles(root, secrets)
  for (const row of rows) {
    if (row.type !== 'stdio') {
      scan(row.url, secrets)
      for (const { header, variable } of row.headers) scan(header + ' ' + variable, secrets)
      continue
    }
    scan(JSON.stringify(standardServer(row)), secrets)

    if (row.command.startsWith('./') && !Object.hasOwn(files, row.command.slice(2))) {
      fail('A stdio executable is outside the exported skill or script files.')
    }
    const rooted = row.cwd?.replace(/^\$\{PLUGIN_ROOT\}/, '.')
    if (rooted?.startsWith('./') && rooted !== './' && !paths.has(rooted.slice(2).replace(/\/$/, '').toLowerCase())) {
      fail('A stdio working directory is outside the exported plugin files.')
    }
    if (row.cwd?.split('/').includes('..')) fail('A stdio working directory escapes its export root.')
  }

  const identity = { name: manifest.name }
  for (const key of ['version', 'description', 'license']) {
    const value = manifest[key]
    if (typeof value === 'string' && (key !== 'version' || /^\d+\.\d+\.\d+(?:[-+][a-z0-9.+-]+)?$/i.test(value))) identity[key] = value
  }
  const put = (name, text) => {
    scan(text, secrets)
    files[name] = Buffer.from(text)
  }
  const json = (name, value) => put(name, JSON.stringify(value, null, 2) + '\n')
  // Only the projected MCP configuration may contain opted-in bundled credentials.
  const mcpJson = (name, value) => {
    files[name] = [Buffer.from(JSON.stringify(value, null, 2) + '\n'), { attrs: (0o100600 << 16) >>> 0, os: 3 }]
  }
  const selected = rows.filter(row => {
    if (format === 'standard' && row.portable === false && !row.bearerToken) {
      const vars = row.headers.map(entry => placeholder(entry.variable)).join(', ')
      omitted.push([row.key, 'Requires HTTPS outside loopback.' + (vars ? ' Set up ' + vars + ' after configuring an HTTPS endpoint.' : '')])
      return false
    }
    if ((format === 'codex' || format === 'antigravity') && row.type === 'sse') {
      omitted.push([row.key, 'This preset requires Streamable HTTP for a remote server.'])
      return false
    }
    if (format === 'codex' && row.type === 'stdio'
      && [row.cwd ?? '', ...row.args, ...Object.values(row.env)].some(value => value.includes(placeholder('PLUGIN_DATA')))) {
      omitted.push([row.key, 'This server requires the portable PLUGIN_DATA path, unavailable to native Codex MCPs.'])
      return false
    }
    return true
  })
  const configurations = (entries, render) => Object.fromEntries(entries.map(row => [row.key, render(row)]))
  const branding = manifest.extensions?.['io.heron-ai']
  const title = typeof branding?.title === 'string' && branding.title.trim() ? branding.title.trim() : identity.name
  const card = Array.isArray(branding?.cards) ? branding.cards.find(item => item?.title === title && item.icon) : undefined
  const logo = await readExportLogo(root, branding?.icon ?? card?.icon, secrets)
  const icon = './assets/logo.png'
  if (logo) files[icon.slice(2)] = logo
  if (format === 'standard') {
    const oauth = configurations(selected.filter(row => row.oauth), () => ({ authType: 'oauth' }))
    const extension = {
      ...(title !== identity.name ? { title } : {}),
      ...(logo ? { icon } : {}),
      ...(Object.keys(oauth).length ? { servers: oauth } : {}),
    }
    json('plugin.json', {
      $schema: PLUGIN_SCHEMA, ...identity,
      ...(Object.keys(extension).length ? { extensions: { 'io.heron-ai': extension } } : {}),
    })
    json('mcp.json', { $schema: MCP_SCHEMA, mcpServers: configurations(selected, standardServer) })
    const withBearer = selected.filter(row => row.bearerToken)
    if (withBearer.length) {
      if (Object.hasOwn(files, 'scripts') || paths.has(portableMcpScript) || paths.has(portableMcpConfig)) {
        fail('The plugin already uses a path reserved for portable MCP export.')
      }
      files[portableMcpScript] = await readFile(new URL('./portable-mcp-stdio.mjs', import.meta.url))
      mcpJson(portableMcpConfig, configurations(withBearer, row => ({
        url: row.url, headers: { Authorization: 'Bearer ' + row.bearerToken },
      })))
    }
  }
  if (format === 'claude-code') {
    json('.claude-plugin/plugin.json', { ...identity, displayName: title, ...(logo ? { icon } : {}) })
    mcpJson('.mcp.json', { mcpServers: configurations(selected, row => targetServer(row, format)) })
  }
  if (format === 'codex') {
    const description = identity.description || title
    json('.codex-plugin/plugin.json', {
      ...identity, description,
      ...(skills.length ? { skills: './skills/' } : {}),
      ...(selected.length ? { mcpServers: './.mcp.json' } : {}),
      interface: {
        displayName: title,
        shortDescription: [...description].slice(0, 120).join(''),
        longDescription: description,
        category: 'Productivity',
        ...(logo ? { logo: icon, composerIcon: icon } : {}),
      },
    })
    if (selected.length) mcpJson('.mcp.json', { mcpServers: configurations(selected, codexServer) })
    json('.agents/plugins/marketplace.json', codexMarketplace(identity.name, title))
  }
  if (format === 'antigravity') {
    json('plugin.json', { ...identity, displayName: title, ...(logo ? { logo: icon.slice(2) } : {}) })
    mcpJson('mcp_config.json', { mcpServers: configurations(selected, row => targetServer(row, format)) })
  }
  put('README.md', makeReadme(manifest.name, format, skills, selected, omitted))
  const suffix = format === 'standard' ? '' : '-' + format
  return { fileName: manifest.name + suffix + '.zip', bytes: zipSync(files, { level: 6 }) }
}
