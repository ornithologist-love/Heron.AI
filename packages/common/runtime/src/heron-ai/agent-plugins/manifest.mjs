import { validateHeaderName, validateHeaderValue } from 'node:http'
import { lstat, mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { isIPv4 } from 'node:net'
import path from 'node:path'
import yaml from 'js-yaml'

const schemaBase = 'https://agent-plugins.org/schemas/1.0.0/'
export const PLUGIN_SCHEMA = schemaBase + 'plugin.schema.json'
export const MCP_SCHEMA = schemaBase + 'mcp.schema.json'
const manifestFields = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'])
const pluginName = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?(?![\s\S])/
const skillName = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?![\s\S])/
const nativeServerId = /^[A-Za-z0-9_-]{1,32}(?![\s\S])/
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isString = value => typeof value === 'string'
const stringList = value => Array.isArray(value) && value.every(isString)
const stringMap = value => isObject(value) && Object.values(value).every(isString)
const property = (record, name) => Object.hasOwn(record, name) ? record[name] : undefined

function checkFields(value, allowed, label) {
  if (!isObject(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error(`${label} has invalid or unknown fields`)
  }
}

function assertWithin(root, file, label) {
  const relative = path.relative(root, file)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its root`)
  }
}

async function resolveWithin(root, file, label, kind) {
  assertWithin(root, file, label)
  const resolved = await realpath(file)
  assertWithin(root, resolved, label)
  const info = await stat(resolved)
  if (kind === 'file' ? !info.isFile() : !info.isDirectory()) {
    throw new Error(`${label} must resolve to a ${kind}`)
  }
  return resolved
}

async function exists(file) {
  try { await lstat(file); return true }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

async function readJson(root, name) {
  const file = await resolveWithin(root, path.join(root, name), name, 'file')
  const raw = await readFile(file, 'utf8')
  try { return JSON.parse(raw.replace(/^\uFEFF/, '')) }
  catch { throw new Error(`${name} is not valid JSON`) }
}

function validateManifest(value, diagnose) {
  if (!isObject(value)) throw new Error('plugin.json must contain an object')
  if (value.$schema !== PLUGIN_SCHEMA) throw new Error('plugin.json has an unsupported $schema; expected Agent Plugins 1.0.0')
  if (!isString(value.name) || !pluginName.test(value.name)) throw new Error('plugin.json has an invalid name')
  for (const field of ['version', 'description', 'homepage', 'repository', 'license']) {
    if (value[field] !== undefined && !isString(value[field])) throw new Error(`plugin.json ${field} must be a string`)
  }
  if (value.author !== undefined) {
    checkFields(value.author, ['name', 'email', 'url'], 'plugin.json author')
    if (!stringMap(value.author)) throw new Error('plugin.json author values must be strings')
  }
  if (value.keywords !== undefined && !stringList(value.keywords)) throw new Error('plugin.json keywords must be strings')
  for (const key of Object.keys(value)) {
    if (!manifestFields.has(key)) diagnose(`plugin.json ignores unknown field ${key}`)
  }
  if (value.extensions !== undefined && !isObject(value.extensions)) diagnose('plugin.json ignores non-object extensions')
}

function presentation(value, defaultTitle, defaultDescription = '') {
  const description = value.description
  if (description !== undefined && (!isObject(description) || !isString(description.zh) || !isString(description.en))) {
    throw new Error('connector description must have zh and en strings')
  }
  if (value.title !== undefined && (!isString(value.title) || !value.title.trim())) throw new Error('connector title must be a nonempty string')
  return {
    title: value.title ?? defaultTitle,
    description: description === undefined ? { zh: defaultDescription, en: defaultDescription } : { zh: description.zh, en: description.en },
  }
}

async function readIcon(root, file) {
  if (file === undefined) return undefined
  if (!isString(file) || !file.startsWith('./')) throw new Error('connector icon must be a package-relative PNG or SVG')
  const resolved = await resolveWithin(root, path.resolve(root, file), 'connector icon', 'file')
  switch (path.extname(resolved).toLowerCase()) {
    case '.png': return 'data:image/png;base64,' + await readFile(resolved, 'base64')
    case '.svg': return 'data:image/svg+xml,' + encodeURIComponent(await readFile(resolved, 'utf8'))
    default: throw new Error('connector icon must be a PNG or SVG')
  }
}

function httpUrl(raw) {
  if (!isString(raw) || !/^https?:\/\//i.test(raw) || raw.trim() !== raw || raw.includes('#')) {
    throw new Error('MCP URL must be an absolute HTTP(S) URL without a fragment')
  }
  let url
  try { url = new URL(raw) }
  catch { throw new Error('MCP URL must be valid') }
  if (url.username || url.password) throw new Error('MCP URL must not include user information')
  const loopback = ['localhost', '[::1]'].includes(url.hostname) || (isIPv4(url.hostname) && url.hostname.startsWith('127.'))
  if (url.protocol === 'http:' && !loopback) {
    throw new Error('MCP URL requires HTTPS for non-loopback endpoints')
  }
  return raw
}

function httpHeaders(headers) {
  if (!stringMap(headers)) throw new Error('MCP headers must be strings')
  const names = new Set()
  for (const [name, value] of Object.entries(headers)) {
    const folded = name.toLowerCase()
    if (names.has(folded)) throw new Error('MCP header names must be unique ignoring case')
    names.add(folded)
    try { validateHeaderName(name); validateHeaderValue(name, value) }
    catch { throw new Error('MCP header name or value is invalid') }
  }
  return headers
}

async function stdioEntry(spec, root, getDataDir) {
  checkFields(spec, ['type', 'command', 'args', 'env', 'cwd'], 'stdio MCP server')
  if (!isString(spec.command) || !spec.command || spec.command.includes('\0')) throw new Error('stdio command must name one executable')
  if (spec.args !== undefined && !stringList(spec.args)) throw new Error('stdio args must be strings')
  if (spec.env !== undefined && !stringMap(spec.env)) throw new Error('stdio env values must be strings')
  const env = Object.entries(spec.env ?? {})
  for (const [name] of env) {
    const normalized = process.platform === 'win32' ? name.toUpperCase() : name
    if (normalized === 'PLUGIN_ROOT' || normalized === 'PLUGIN_DATA') throw new Error('stdio env cannot set PLUGIN_ROOT or PLUGIN_DATA')
    if (!name || /[=\0]/.test(name)) throw new Error('stdio env contains an invalid name')
  }
  let command = spec.command
  if (command.startsWith('./')) command = await resolveWithin(root, path.resolve(root, command), 'stdio command', 'file')
  else if (command === '.' || command === '..' || /[\\/:\s]/.test(command) || command.includes('${')) {
    throw new Error('stdio command must be a bare executable or start with ./')
  }

  const data = await getDataDir()
  const expand = value => value.replace(/\$\{PLUGIN_(ROOT|DATA)\}/g, (_, name) => name === 'ROOT' ? root : data)
  let cwd = root
  if (spec.cwd !== undefined) {
    if (!isString(spec.cwd) || !/^(?:\.\/|\$\{PLUGIN_(?:ROOT|DATA)\}(?:\/|$))/.test(spec.cwd)) {
      throw new Error('stdio cwd must be rooted at the plugin or its data directory')
    }
    const workingRoot = spec.cwd.startsWith('${PLUGIN_DATA}') ? data : root
    cwd = await resolveWithin(workingRoot, path.resolve(root, expand(spec.cwd)), 'stdio cwd', 'directory')
  }
  return {
    transport: 'stdio', command, cwd,
    ...(spec.args === undefined ? {} : { args: spec.args.map(expand) }),
    env: { ...Object.fromEntries(env.map(([name, value]) => [name, expand(value)])), PLUGIN_ROOT: root, PLUGIN_DATA: data },
  }
}

function connectorMetadata(key, value = {}) {
  if (!isObject(value)) throw new Error('Heron MCP metadata must be an object')
  const card = presentation(value, key)
  if (value.existingId !== undefined && (!isString(value.existingId) || !nativeServerId.test(value.existingId))) {
    throw new Error('Heron existing MCP identifier is invalid')
  }
  for (const flag of ['eager', 'enabled']) {
    if (value[flag] !== undefined && typeof value[flag] !== 'boolean') throw new Error(`Heron ${flag} must be a boolean`)
  }
  if (value.authType !== undefined && !['none', 'oauth'].includes(value.authType)) throw new Error('Heron authType must be none or oauth')
  if (value.scopes !== undefined && !stringList(value.scopes)) throw new Error('Heron OAuth scopes must be strings')
  if (value.displayName !== undefined && (!isString(value.displayName) || !value.displayName.trim())) throw new Error('Heron displayName must be a nonempty string')
  return {
    key, ...card, existingId: value.existingId, displayName: value.displayName, eager: value.eager,
    previousUrl: value.previousUrl === undefined ? undefined : httpUrl(value.previousUrl),
  }
}

async function readServers(root, extension, diagnose, getDataDir) {
  if (extension.servers !== undefined && !isObject(extension.servers)) diagnose('Heron ignores non-object server metadata')
  const metadata = isObject(extension.servers) ? extension.servers : {}
  let sources = {}
  try {
    if (await exists(path.join(root, 'mcp.json'))) {
      const config = await readJson(root, 'mcp.json')
      checkFields(config, ['$schema', 'mcpServers'], 'mcp.json')
      if (config.$schema !== MCP_SCHEMA) throw new Error('mcp.json has an unsupported $schema; expected Agent Plugins 1.0.0')
      if (!isObject(config.mcpServers)) throw new Error('mcp.json mcpServers must be an object')
      sources = config.mcpServers
    }
  } catch (error) { diagnose(error.message); return [] }

  const servers = []
  for (const key of new Set([...Object.keys(sources), ...Object.keys(metadata)])) {
    try {
      const value = property(metadata, key) ?? {}
      const server = connectorMetadata(key, value)
      if (!Object.hasOwn(sources, key)) {
        if (server.existingId) servers.push(server)
        continue
      }
      const spec = sources[key]
      let entry
      if (spec?.type === 'stdio') entry = await stdioEntry(spec, root, getDataDir)
      else if (spec?.type === 'streamable-http' || spec?.type === 'sse') {
        checkFields(spec, ['type', 'url', 'headers'], 'HTTP MCP server')
        entry = { transport: spec.type, url: httpUrl(spec.url) }
        if (spec.headers !== undefined) entry.headers = httpHeaders(spec.headers)
      } else throw new Error('MCP transport must be stdio, streamable-http or sse')
      const authType = value.authType ?? (value.scopes !== undefined ? 'oauth' : 'none')
      if (authType === 'oauth' && entry.transport === 'stdio') throw new Error('Heron OAuth requires an HTTP MCP transport')
      server.entry = {
        ...entry, authType, enabled: value.enabled ?? authType !== 'oauth',
        ...(authType === 'oauth' && value.scopes !== undefined ? { oauth: { scopes: value.scopes } } : {}),
      }
      servers.push(server)
    } catch (error) { diagnose(`mcp.json server ${JSON.stringify(key)}: ${error.message}`) }
  }
  return servers
}

/** Reads a skill's current package files, repeating containment checks after discovery. */
export async function readAgentSkill(pluginRoot, skill) {
  const name = typeof skill === 'string' ? skill : skill?.name
  if (!isString(name) || !skillName.test(name)) throw new Error('invalid Agent Skill name')
  const root = await realpath(pluginRoot)
  const skillsRoot = await resolveWithin(root, path.join(root, 'skills'), 'skills', 'directory')
  const directory = await resolveWithin(root, path.join(skillsRoot, name), 'skill directory', 'directory')
  const entryPath = await resolveWithin(root, path.join(directory, 'SKILL.md'), 'SKILL.md', 'file')
  const raw = await readFile(entryPath, 'utf8')
  const frontmatter = raw.match(/^\uFEFF?---\r?\n([\s\S]*?)^---(?:\r?\n|$)/m)
  if (!frontmatter || frontmatter.index !== 0) throw new Error('SKILL.md requires YAML frontmatter')
  let fields
  try { fields = yaml.load(frontmatter[1]) }
  catch { throw new Error('SKILL.md has invalid YAML frontmatter') }
  if (!isObject(fields) || fields.name !== name || !isString(fields.description)
    || !fields.description.trim() || [...fields.description].length > 1024) {
    throw new Error('SKILL.md requires a matching name and a description of 1–1024 characters')
  }
  if (fields.license !== undefined && !isString(fields.license)) throw new Error('invalid SKILL.md license')
  if (fields.compatibility !== undefined && (!isString(fields.compatibility) || !fields.compatibility.trim() || [...fields.compatibility].length > 500)) {
    throw new Error('invalid SKILL.md compatibility')
  }
  if (fields.metadata !== undefined && !stringMap(fields.metadata)) throw new Error('invalid SKILL.md metadata')
  if (fields['allowed-tools'] !== undefined && !isString(fields['allowed-tools'])) throw new Error('invalid SKILL.md allowed-tools')
  for (const field of ['disable-model-invocation', 'user-invocable']) {
    if (fields[field] !== undefined && typeof fields[field] !== 'boolean') throw new Error(`invalid SKILL.md ${field}`)
  }
  return {
    name, description: fields.description, root: directory, entryPath, content: raw.slice(frontmatter[0].length).trim(),
    ...(fields.metadata === undefined ? {} : { metadata: fields.metadata }),
    ...(isString(fields.whenToUse) ? { whenToUse: fields.whenToUse } : {}),
    invocation: { modelInvocable: fields['disable-model-invocation'] !== true, userInvocable: fields['user-invocable'] !== false },
  }
}

async function readSkills(root, diagnose) {
  const skills = []
  try {
    const fixedPath = path.join(root, 'skills')
    if (!await exists(fixedPath)) return skills
    const directory = await resolveWithin(root, fixedPath, 'skills', 'directory')
    for (const child of await readdir(directory, { withFileTypes: true })) {
      if (!child.isDirectory() && !child.isSymbolicLink()) continue
      try {
        const skillDir = await resolveWithin(root, path.join(directory, child.name), 'skill directory', 'directory')
        if (!await exists(path.join(skillDir, 'SKILL.md'))) continue
        const { content: _content, ...skill } = await readAgentSkill(root, child.name)
        skills.push(skill)
      } catch (error) { diagnose(`skills/${child.name}: ${error.message}`) }
    }
  } catch (error) { diagnose(error.message) }
  return skills
}

async function readCards(root, cards, diagnose) {
  if (cards === undefined) return []
  if (!Array.isArray(cards)) { diagnose('Heron ignores non-array cards'); return [] }
  const result = []
  const ids = new Set()
  for (const card of cards) {
    try {
      if (!isObject(card) || !isString(card.id) || !pluginName.test(card.id) || !isString(card.title)
        || !card.title.trim() || !stringList(card.servers) || new Set(card.servers).size !== card.servers.length || ids.has(card.id)) {
        throw new Error('Heron cards require a unique id, title and unique server keys')
      }
      const icon = await readIcon(root, card.icon)
      result.push({ id: card.id, ...presentation(card, card.title), icon, servers: card.servers })
      ids.add(card.id)
    } catch (error) { diagnose(error.message) }
  }
  return result
}

/** Read the identity and manifest without preparing server or skill resources. */
export async function readAgentPluginManifest(directory, { bundled = false, onDiagnostic = () => {} } = {}) {
  const root = await realpath(directory)
  if (!(await stat(root)).isDirectory()) throw new Error('Agent Plugin root must be a directory')
  const filename = bundled && await exists(path.join(root, 'agent-plugin.json')) ? 'agent-plugin.json' : 'plugin.json'
  const manifest = await readJson(root, filename)
  validateManifest(manifest, onDiagnostic)
  return { root, filename, manifest }
}

/** Loads the locally supported 1.0.0 schemas without retrieving anything over the network. */
export async function readAgentPlugin(directory, dataDir, { bundled = false, onDiagnostic = () => {} } = {}) {
  const { root, manifest } = await readAgentPluginManifest(directory, { bundled, onDiagnostic })
  const declared = isObject(manifest.extensions) ? property(manifest.extensions, 'io.heron-ai') : undefined
  const extension = isObject(declared) ? declared : {}
  if (declared !== undefined && !isObject(declared)) onDiagnostic('plugin.json ignores invalid io.heron-ai extension')
  const fallback = presentation({}, manifest.name, manifest.description)
  let brand = fallback
  try { brand = presentation(extension, manifest.name, manifest.description) }
  catch (error) { onDiagnostic(error.message) }
  let icon
  try { icon = await readIcon(root, extension.icon) }
  catch (error) { onDiagnostic(error.message) }

  let resolvedDataDir
  const getDataDir = () => resolvedDataDir ??= (async () => {
    const target = typeof dataDir === 'function' ? dataDir(manifest.name) : dataDir
    if (!isString(target) || !path.isAbsolute(target)) throw new Error('stdio requires a client-managed absolute plugin data directory')
    await mkdir(target, { recursive: true })
    return await realpath(target)
  })()
  const [servers, skills, cards] = await Promise.all([
    readServers(root, extension, onDiagnostic, getDataDir), readSkills(root, onDiagnostic), readCards(root, extension.cards, onDiagnostic),
  ])
  const skillProviderName = extension.skillProviderName
  if (skillProviderName !== undefined && (!isString(skillProviderName) || !pluginName.test(skillProviderName))) {
    onDiagnostic('Heron ignores invalid skillProviderName')
  }
  return {
    root, name: manifest.name, version: manifest.version, ...brand, icon, servers, skills, cards,
    skillProviderName: isString(skillProviderName) && pluginName.test(skillProviderName) ? skillProviderName : undefined,
  }
}
