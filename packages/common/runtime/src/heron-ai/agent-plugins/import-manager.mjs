import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { readAgentPlugin } from './manifest.mjs'
import { discoverAgentPluginCandidates, normalizeAgentPluginSource, resolveAgentPluginCandidate } from './import-adapters.mjs'
import { AgentPluginImportError, extractAgentPluginZip, MAX_AGENT_PLUGIN_ZIP } from './import-files.mjs'

const previewLifetime = 10 * 60_000
const previewSlots = 4
const fail = message => { throw new AgentPluginImportError(message) }
const hasOwn = (record, key) => record && Object.hasOwn(record, key)
const json = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''))
const save = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n')

async function archiveRoot(directory) {
  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .filter(entry => !['__MACOSX', '.DS_Store'].includes(entry.name))
  if (entries.length === 1 && entries[0].isDirectory()) {
    const nested = path.join(directory, entries[0].name)
    const markers = ['plugin.json', '.claude-plugin', '.codex-plugin', '.antigravity-plugin', 'mcp_config.json', 'config.toml']
    const found = await fs.readdir(nested)
    if (markers.some(marker => found.includes(marker))) return nested
  }
  return directory
}

async function localSource(input, staging, homeDir) {
  if (input.source) {
    return resolveAgentPluginCandidate(input.source, input.candidate, { homeDir })
  }
  let bytes = input.zipBytes
  if (!bytes) {
    if (typeof input.directory !== 'string' || !path.isAbsolute(input.directory)) fail('请选择本地插件目录或 ZIP 文件。')
    const stat = await fs.lstat(input.directory).catch(error => {
      if (error.code === 'ENOENT') fail('找不到指定的插件目录或 ZIP 文件。')
      throw error
    })
    if (stat.isDirectory()) return { directory: input.directory }
    if (!stat.isFile() || path.extname(input.directory).toLowerCase() !== '.zip') fail('请选择普通插件目录或 ZIP 文件。')
    if (stat.size > MAX_AGENT_PLUGIN_ZIP) fail('ZIP 压缩包超过 16 MiB。')
    const file = await fs.open(input.directory, 'r')
    try {
      const bounded = Buffer.alloc(stat.size + 1)
      let offset = 0
      while (offset <= stat.size) {
        const { bytesRead } = await file.read(bounded, offset, bounded.length - offset, offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      if (offset !== stat.size) fail('ZIP 文件在读取时发生变化，请重新预览。')
      bytes = bounded.subarray(0, offset)
    } finally { await file.close() }
  }
  const extracted = path.join(staging, 'extracted')
  await extractAgentPluginZip(bytes, extracted)
  return { directory: await archiveRoot(extracted) }
}

async function validatePackage(directory, staging) {
  const diagnostics = []
  let plugin
  try {
    plugin = await readAgentPlugin(directory, () => path.join(staging, 'plugin-data'), {
      onDiagnostic: message => diagnostics.push(message),
    })
  } catch (error) {
    fail(error.message.startsWith('plugin.json') ? error.message : '无法读取标准 Agent Plugin 清单。')
  }
  const blocking = diagnostics.find(message => !message.startsWith('plugin.json ignores unknown field '))
  if (blocking) fail(blocking)
  return { plugin, diagnostics }
}

function summarizeArgs(args) {
  let previousHasValue = false
  return args.map(arg => {
    const sensitivity = /^-{1,2}[\w-]*(?:token|secret|password|api[-_]?key)(?:=|$)/i.exec(arg)
    const shorten = value => value.length > 512 ? value.slice(0, 512) + '…' : value
    const summary = previousHasValue ? '••••' : sensitivity && sensitivity[0].endsWith('=')
      ? sensitivity[0] + '••••' : shorten(arg.replace(/(Bearer )\S+/ig, '$1••••'))
    previousHasValue = sensitivity !== null && !sensitivity[0].endsWith('=')
    return summary
  })
}

async function selectComponents(item, serverIds, skillNames) {
  const only = (all, selected, label) => {
    const choices = new Set(selected)
    if (choices.size !== selected.length || selected.some(key => !all.includes(key))) fail('所选' + label + '与预览不一致。')
    return choices
  }
  const allowedServers = only(item.preview.servers.map(server => server.id), serverIds, ' MCP')
  const allowedSkills = only(item.preview.skills.map(skill => skill.name), skillNames, '技能')
  if (!allowedServers.size && !allowedSkills.size && (item.preview.servers.length || item.preview.skills.length)) {
    fail('请至少选择一个 MCP 或技能。')
  }
  const manifestFile = path.join(item.directory, 'plugin.json')
  const manifest = await json(manifestFile)
  const extension = manifest.extensions?.['io.heron-ai']
  if (extension?.servers) {
    extension.servers = Object.fromEntries(Object.entries(extension.servers).filter(([id]) => allowedServers.has(id)))
  }
  if (Array.isArray(extension?.cards)) {
    extension.cards = extension.cards.map(card => ({ ...card, servers: card.servers.filter(id => allowedServers.has(id)) }))
      .filter(card => card.servers.length > 0)
  }
  await save(manifestFile, manifest)
  if (item.mcp) {
    item.mcp.mcpServers = Object.fromEntries(Object.entries(item.mcp.mcpServers).filter(([id]) => allowedServers.has(id)))
    await save(path.join(item.directory, 'mcp.json'), item.mcp)
  }
  for (const { name } of item.preview.skills) {
    if (!allowedSkills.has(name)) await fs.rm(path.join(item.directory, 'skills', name), { recursive: true })
  }
}

export function createAgentPluginImporter(ctx, home, activate, { homeDir } = {}) {
  const pending = new Map()
  let preparing = 0
  function take(id) {
    const item = pending.get(id)
    if (!item) return
    clearTimeout(item.expiry)
    pending.delete(id)
    return item
  }
  async function discard(id) {
    const item = take(id)
    if (item) await fs.rm(item.staging, { recursive: true, force: true })
  }
  ctx.effect(() => () => {
    for (const id of pending.keys()) void discard(id).catch(() => {})
  })

  return {
    discover: source => discoverAgentPluginCandidates(source, { homeDir }),
    async preview(input) {
      if (pending.size + preparing >= previewSlots) fail('待确认的导入太多，请先取消或完成已有预览。')
      preparing++
      let staging
      try {
        await fs.mkdir(home, { recursive: true })
        staging = await fs.mkdtemp(path.join(home, '.agent-plugin-import-'))
        const source = await localSource(input, staging, homeDir)
        const directory = path.join(staging, 'package')
        const { format, warnings = [] } = await normalizeAgentPluginSource(source.directory, directory, source)
        const { plugin, diagnostics } = await validatePackage(directory, staging)
        const config = path.join(directory, 'mcp.json')
        const mcp = await json(config).catch(error => {
          if (error.code !== 'ENOENT') throw error
        })
        const servers = plugin.servers.filter(server => server.entry).map(({ key: id, entry }) => {
          const row = hasOwn(mcp?.mcpServers, id) ? mcp.mcpServers[id] : undefined
          return entry.transport === 'stdio'
            ? { id, command: row.command, args: summarizeArgs(row.args ?? []) }
            : { id }
        })
        const id = randomUUID()
        const preview = { id, name: plugin.name, format, servers, skills: plugin.skills.map(({ name }) => ({ name })),
          warnings: [...warnings, ...diagnostics] }
        const expiry = setTimeout(() => void discard(id).catch(() => {}), previewLifetime)
        expiry.unref()
        pending.set(id, { staging, directory, preview, mcp, expiry })
        return preview
      } catch (error) {
        if (staging) await fs.rm(staging, { recursive: true, force: true })
        throw error
      } finally { preparing-- }
    },
    async commit({ id, serverIds, skillNames, allowStdio }) {
      const current = pending.get(id)
      if (!current) fail('导入预览已过期，请重新选择文件。')
      if (allowStdio !== true && current.preview.servers.some(server => server.command && serverIds.includes(server.id))) {
        fail('请先确认将运行的 stdio 命令。')
      }
      const item = take(id)
      try {
        await selectComponents(item, serverIds, skillNames)
        const { plugin } = await validatePackage(item.directory, item.staging)
        await activate(item.directory, plugin.name)
      } finally {
        await fs.rm(item.staging, { recursive: true, force: true })
      }
    },
    discard,
  }
}
