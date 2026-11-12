import fs from 'node:fs/promises'
import path from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { digest, filesBelow, migrationRoot, progress, readJson, saveJson } from './files.mjs'
import { migrateOAuth } from './oauth.mjs'
import { readMcpConfiguration } from '../product-profile.mjs'

export function nativeEntry(serverName, item) {
  return { serverName, transport: item.command ? 'stdio' : 'streamable-http', enabled: item.disabled !== true,
    ...(item.command ? { command: item.command, args: item.args ?? [], env: item.env, cwd: item.cwd }
      : { url: item.url, headers: { ...item.headers, ...(item.auth === 'bearer' && item.bearerToken ? { Authorization: `Bearer ${item.bearerToken}` } : {}) } }),
    ...(item.requestTimeoutMs ? { toolCallTimeoutMs: item.requestTimeoutMs } : {}),
    authType: item.auth === 'oauth' || item.oauth ? 'oauth' : 'none',
    ...(item.oauth ? { oauth: { ...item.oauth, clientId: item.oauth.clientId ?? item.oauth.client_id,
      clientSecret: item.oauth.clientSecret ?? item.oauth.client_secret } } : {}) }
}
function supported(item) {
  const known = new Set(['command','args','env','cwd','url','headers','auth','bearerToken','bearerTokenEnv','oauth','disabled',
    'httpTransport','requestTimeoutMs','literalEnv','lifecycle','managed'])
  // DSH owns resident startup connections. Legacy startup modes use that
  // native lifecycle; deferred-start policies need explicit user adjustment.
  return Object.keys(item).filter(key => !known.has(key))
    .concat(item.httpTransport === 'sse' ? ['httpTransport=sse'] : [])
    .concat(item.lifecycle && !['eager','keep-alive'].includes(item.lifecycle) ? ['lifecycle=' + item.lifecycle] : [])
}
async function skillFingerprint(root) {
  const files = await filesBelow(root)
  const bytes = await Promise.all(files.map(async file => path.relative(root,file) + '\0' + digest(await fs.readFile(file))))
  return digest(bytes.join('\n'))
}
export async function migrateConfiguration(options) {
  const root = migrationRoot(options), marker = path.join(root, 'configuration.json')
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  return withFileLock(path.join(root, 'configuration'), async () => {
    const done = await readJson(marker)
    if (done?.completed && done.version === 2) return done
    const report = { version: 2, skills: 0, skillsAlreadyPresent: 0, skillConflicts: 0, mcp: 0, mcpConflicts: 0, warnings: [] }
    progress('正在迁移旧版配置…')
    const legacySkills = path.join(options.stateDir, '.agents', 'skills-legacy')
    let entries = []
    try { entries = await fs.readdir(legacySkills, { withFileTypes: true }) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const source = path.join(legacySkills, entry.name), skillRoot = path.join(options.stateDir, '.agents', 'skills')
      const fingerprint = await skillFingerprint(source)
      let destination = path.join(skillRoot, entry.name)
      try {
        await fs.access(destination)
        if (await skillFingerprint(destination) === fingerprint) { report.skillsAlreadyPresent++; continue }
        // Preserve the current skill, including edits, as the primary name.
        destination = path.join(skillRoot, `${entry.name.slice(0,46)}-legacy-${fingerprint.slice(0, 8)}`)
        report.skillConflicts++
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      try { await fs.access(destination) }
      catch (error) {
        if (error.code !== 'ENOENT') throw error
        const staging = path.join(skillRoot, '.migration-' + digest(entry.name + ':' + fingerprint).slice(0, 16))
        await fs.mkdir(skillRoot, { recursive: true })
        await fs.cp(source, staging, { recursive: true, verbatimSymlinks: true })
        if (path.basename(destination) !== entry.name) {
          const skill = path.join(staging,'SKILL.md')
          try {
            const text = await fs.readFile(skill,'utf8'), header = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text)?.[0]
            if (header) await fs.writeFile(skill,text.replace(header,header.replace(/^name:\s*.*$/m,'name: ' + path.basename(destination))))
          } catch (error) { if (error.code !== 'ENOENT') throw error }
        }
        await fs.rename(staging, destination)
      }
      report.skills++
    }
    const target = path.join(options.home, 'mcp-servers.json')
    const bundled = readMcpConfiguration(options)
    const stored = await readJson(target)
    const current = stored ?? { version: 1, servers: Object.entries(bundled?.mcpServers ?? {})
      .filter(([name]) => options.bundledMcpServers === undefined || options.bundledMcpServers.includes(name))
      .map(([name,item]) => ({ ...nativeEntry(name,item), enabled: item.disabled !== true && options.bundledMcpServersEnabled !== false })) }
    if (!Array.isArray(current.servers)) throw Error('新版 MCP 配置格式无效，迁移未覆盖该文件。')
    const legacy = await readJson(path.join(options.stateDir, 'mcp.json'))
    if (legacy?.mcpServers !== undefined && (!legacy.mcpServers || typeof legacy.mcpServers !== 'object' || Array.isArray(legacy.mcpServers)))
      throw Error('旧版 MCP 配置格式无效，原文件已保留。')
    for (const [originalName,item] of Object.entries(legacy?.mcpServers ?? {})) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw Error('旧版 MCP 服务配置格式无效，原文件已保留。')
      const suffix = digest(originalName).slice(0, 8)
      const name = /^[A-Za-z0-9_-]{1,32}$/.test(originalName) ? originalName : 'legacy-' + suffix
      const definition = item.disabled === true && !item.command && !item.url ? { ...bundled?.mcpServers?.[originalName],...item } : item
      const incoming = nativeEntry(name,definition), existing = stored && current.servers.find(server => server.serverName === name)
      if (existing) {
        const keys = Object.keys(incoming).filter(key => key !== 'oauth')
        const equal = keys.every(key => JSON.stringify(existing[key]) === JSON.stringify(incoming[key]))
          && (!item.oauth || JSON.stringify(existing.oauth) === JSON.stringify(incoming.oauth))
        if (equal && !supported(item).length && !item.bearerTokenEnv) continue
        incoming.serverName = name.slice(0, 16) + '-legacy-' + suffix
        // Keep the existing connection authoritative. Retain the old variant
        // for selection without silently activating a second connection.
        incoming.enabled = false
        report.mcpConflicts++
      }
      incoming.legacy = { name: originalName, config: item, unsupported: supported(item), baseline: { ...incoming } }
      if (!stored) current.servers = current.servers.filter(server => server.serverName !== incoming.serverName)
      if (!current.servers.some(server => server.serverName === incoming.serverName)) current.servers.push(incoming)
      if (incoming.legacy.unsupported.length) report.warnings.push({ server: incoming.serverName, fields: incoming.legacy.unsupported })
      report.mcp++
    }
    if (legacy?.settings) current.legacySettings = legacy.settings
    await migrateOAuth(options,current.servers,report)
    await saveJson(target, current)
    report.completed = true
    await saveJson(marker, report)
    return report
  }, { waitMs: 30000 })
}

// Keep symbolic environment references symbolic on disk; resolve them for each
// connection. Unknown old policies must never silently become broader access.
export function migratedMcpEntry(entry, headers) {
  const legacy = entry.legacy
  if (!legacy) return { entry, headers }
  const reviewed = Object.keys(legacy.baseline ?? {}).filter(key => !['enabled','oauth'].includes(key))
    .some(key => JSON.stringify(entry[key]) !== JSON.stringify(legacy.baseline[key]))
  if (reviewed) return { entry, headers }
  if (legacy.unsupported?.length)
    throw Error('旧版配置已完整保留；以下设置不能自动转换，请在编辑页调整新配置：' + legacy.unsupported.join('、'))
  const expand = value => typeof value === 'string' && !legacy.config.literalEnv
    ? value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_,key) => {
      if (process.env[key] === undefined) throw Error('MCP 所需环境变量未设置：' + key)
      return process.env[key]
    }) : value
  const actual = { ...entry, ...(entry.env ? { env: Object.fromEntries(Object.entries(entry.env).map(([key,value]) => [key,expand(value)])) } : {}) }
  const resolved = Object.fromEntries(Object.entries(headers ?? entry.headers ?? {}).map(([key,value]) => [key,expand(value)]))
  if (legacy.config.bearerTokenEnv) {
    const token = process.env[legacy.config.bearerTokenEnv]
    if (!token) throw Error('MCP 所需环境变量未设置：' + legacy.config.bearerTokenEnv)
    resolved.Authorization = 'Bearer ' + token
  }
  return { entry: actual, headers: resolved }
}
