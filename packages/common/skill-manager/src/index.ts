/**
 * dsh-skill-manager, host half: a richer skill catalog read for the web GUI,
 * plus a bounded file browser/editor over skill directories.
 *
 * The shipped `skill.list` RPC deliberately projects only
 * name/description/whenToUse/modelInvocable — provider/source vocabulary stays
 * host-side (see harness `packages/host/apiproxy/src/api/skills.ts`). This
 * plugin serves a management view instead: it reads the layered `ctx.skills`
 * registry (SkillRegistry.list with the session's scope and project cwd),
 * groups project skills by workspace, and answers file-tree / read / write
 * endpoints over each skill's directory (via `ctx.fs`), with system (bundled)
 * skills read-only — without any harness change.
 *
 * @module dsh-skill-manager
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { Config as PresentationOptions, SkillSectionRule } from './presentation-options.ts'
export type { SkillSectionRule } from './presentation-options.ts'
import type { ConnectionRpcResult as RpcResult } from '@deepseek-ai/dsh-client-connection'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { unzipSync, zipSync } from 'fflate'
// Same parser the Harness's skill loader uses (`@deepseek-ai/dsh-skill-filesystem`),
// so "this editor accepted it" and "the catalog will load it" cannot disagree.
import { parse as parseYaml } from 'yaml'
import {
  access as nodeAccess, mkdir as nodeMkdir, readFile as nodeReadFile, readdir as nodeReaddir,
  realpath as nodeRealpath, rename as nodeRename, rm as nodeRm, writeFile as nodeWriteFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
// Type-only: pulls the dsh-skill (ctx.skills) and client-connection
// (ctx.connection) Context merges into this program.
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { API_PATH, clientRequestSchema, type HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-skill-manager'

interface ReadOnlySkillSource {
  readonly provider: string
  readonly directory: string
}

export interface Config extends PresentationOptions {
  readonly readOnlySources?: readonly ReadOnlySkillSource[]
}

/** Workspace attribution of one project skill row. */
export interface SkillManagerWorkspace {
  /** Durable workspace record id, when the registry knows this path. */
  readonly id?: string
  /** Display title: the registered workspace title, else the project dir basename. */
  readonly title: string
  /** The workspace root directory (project root). */
  readonly path: string
}

/** Wire projection of one catalog row, as served to the management panel. */
export interface SkillManagerEntry {
  /** Kebab-case skill identifier. */
  readonly name: string
  /** Short routing description. */
  readonly description: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
  /** Grouping bucket: system / user / project / custom / plugin. */
  readonly tier: 'system' | 'user' | 'project' | 'custom' | 'plugin'
  /** Whether the row is read-only (system skills are never editable). */
  readonly readOnly: boolean
  /** Provider that owns this winning skill body. */
  readonly provider: string
  /** Whether the model catalog lists it (false = user-only invocation). */
  readonly modelInvocable: boolean
  /** Whether the user may invoke it explicitly (e.g. `/name`). */
  readonly userInvocable: boolean
  /** Absolute path of the skill directory (resourceBase), when provider-backed. */
  readonly resourcePath?: string
  /** Whether this filesystem skill is disabled (hidden under `.system/`). */
  readonly disabled?: boolean
  /** Visible directory path passed to toggleSkill to restore a disabled skill. */
  readonly restorePath?: string
  /** Project skill rows carry their owning workspace attribution. */
  readonly workspace?: SkillManagerWorkspace
  /** Preset-provided (custom-source) rows carry their owning preset id. */
  readonly preset?: string
}

/** The `skillManager.list` request payload. */
export interface SkillManagerListRequest {
  /** Session whose scope and project cwd select the layered catalog. */
  readonly sessionId?: SessionId
}

/** One workspace row in the catalog, including workspaces without skills. */
export interface SkillManagerWorkspaceRow {
  /** Durable workspace record id. */
  readonly id?: string
  /** Display title. */
  readonly title: string
  /** The workspace root directory. */
  readonly path: string
  /** Number of project skills this workspace currently provides. */
  readonly skillCount: number
}

/** The `skillManager.list` success value. */
export interface SkillManagerListValue {
  /** Catalog rows sorted by name, including configured read-only sources and disabled filesystem skills. */
  readonly skills: readonly SkillManagerEntry[]
  /** Every registered workspace, non-empty ones first, then empty ones (for import targets). */
  readonly workspaces: readonly SkillManagerWorkspaceRow[]
  /** Whether discovery completed within a stable revision. */
  readonly complete: boolean
}

/** One node of a skill directory file tree. */
export interface SkillManagerFileNode {
  /** Entry name (basename). */
  readonly name: string
  /** Directory or regular file. */
  readonly kind: 'directory' | 'file'
  /** Absolute path of this node. */
  readonly path: string
  /** Byte size, when known (files). */
  readonly size?: number
  /** Nested children, when a directory. */
  readonly children?: readonly SkillManagerFileNode[]
}

/** The `skillManager.files` request/response. */
export interface SkillManagerFilesRequest {
  /** Absolute path of the directory to list (recursive). */
  readonly path: string
}
export interface SkillManagerFilesValue {
  /** One root node carrying the full recursive tree. */
  readonly root: SkillManagerFileNode
}

/** The `skillManager.read` request/response. */
export interface SkillManagerReadRequest {
  /** Absolute path of the regular file to read. */
  readonly path: string
}
export interface SkillManagerReadValue {
  /** The full decoded UTF-8 content. */
  readonly content: string
}

/** The `skillManager.write` request/response. */
export interface SkillManagerWriteRequest {
  /** Absolute path of the regular file to replace. */
  readonly path: string
  /** Full new content. */
  readonly content: string
}
export interface SkillManagerWriteValue {
  /** Whether the write was applied. */
  readonly ok: true
}

/** The `skillManager.importSkill` request/response. */
export interface SkillManagerImportRequest {
  /** The zip bytes as base64 (each top-level dir with SKILL.md = one skill). */
  readonly zipBase64: string
  /** Target: `user` imports into the user skills root, `workspace` into the given workspace's `.dsh/skills`. */
  readonly tier: 'user' | 'workspace'
  /** The workspace root directory for `tier: 'workspace'`. */
  readonly workspacePath?: string
}
export interface SkillManagerImportValue {
  /** Names of the skills imported. */
  readonly imported: readonly string[]
}

/** The `skillManager.exportSkill` request/response. */
export interface SkillManagerExportRequest {
  /** The skill directory to package. */
  readonly path: string
}
export interface SkillManagerExportValue {
  /** Zip bytes as base64. */
  readonly zipBase64: string
  /** Suggested download file name. */
  readonly fileName: string
}

/** The `skillManager.deleteSkill` request/response. */
export interface SkillManagerDeleteRequest {
  /** The skill directory to remove. */
  readonly path: string
}
export interface SkillManagerDeleteValue {
  /** Whether the deletion was applied. */
  readonly ok: true
}

/** The `skillManager.toggleSkill` request/response. */
export interface SkillManagerToggleRequest {
  /** Absolute path of the skill directory (the `.system/` hidden path when disabling is already applied). */
  readonly path: string
  /** `true` restores a hidden skill (rename `.system/<name>` → `<name>`); `false` hides it. */
  readonly enable: boolean
}
export interface SkillManagerToggleValue {
  /** Whether the toggle was applied. */
  readonly ok: true
}

/** The `ctx.skillManager` service provided by this plugin. */
export interface SkillManagerService {
  /**
   * Register a top-level section in the Skill Manager UI at runtime.
   * @param rule - section identity, heading, and provider/preset prefixes to claim.
   * @returns a disposer removing this registration.
   */
  registerSection(rule: SkillSectionRule): () => void
  /**
   * Read the layered skill catalog for a session's scope and project cwd.
   * @param request - optional session address; without one the global layer alone is read.
   * @returns grouped winning summaries with the read-only tier classification.
   */
  list(request: SkillManagerListRequest): Promise<SkillManagerListValue>
  /**
   * List a skill directory recursively as a file tree.
   * @param request - the directory to list.
   * @returns the recursive tree rooted at that directory.
   */
  files(request: SkillManagerFilesRequest): Promise<SkillManagerFilesValue>
  /**
   * Read one regular file inside a skill directory.
   * @param request - the file to read.
   * @returns the decoded text content.
   */
  read(request: SkillManagerReadRequest): Promise<SkillManagerReadValue>
  /**
   * Replace one regular file, refusing system (read-only) skill paths.
   * @param request - the file and its full new content.
   * @returns success after the write is applied.
   */
  write(request: SkillManagerWriteRequest): Promise<SkillManagerWriteValue>
  /**
   * Import skills from an uploaded zip: each top-level directory with a
   * SKILL.md becomes a skill in the target directory (project or user root).
   * @param request - the zip payload (base64) and the target skills directory.
   * @returns the imported skill names.
   */
  importSkill(request: SkillManagerImportRequest): Promise<SkillManagerImportValue>
  /**
   * Export one skill directory as a zip (base64).
   * @param request - the skill directory to package.
   * @returns the zip bytes as base64 with the suggested file name.
   */
  exportSkill(request: SkillManagerExportRequest): Promise<SkillManagerExportValue>
  /**
   * Delete one skill directory, refusing read-only paths.
   * @param request - the skill directory to remove.
   * @returns success after removal.
   */
  deleteSkill(request: SkillManagerDeleteRequest): Promise<SkillManagerDeleteValue>
  /**
   * Enable or disable a filesystem skill by renaming its directory between
   * `<skills>/<name>` and `<skills>/.system/<name>`. The harness filesystem
   * provider ignores `.system`-prefixed directories, so a hidden skill stops
   * being discovered (and invoked) until restored. Provider-backed skills
   * (no restorable directory) are refused.
   * @param request - the skill directory path and the desired state.
   * @returns success after the rename.
   */
  toggleSkill(request: SkillManagerToggleRequest): Promise<SkillManagerToggleValue>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Richer skill catalog reads and file browsing, provided by `dsh-skill-manager`. */
    skillManager: SkillManagerService
  }
}

/**
 * Registry providers that are part of the deployment itself rather than a
 * third-party plugin. A `bundled`-source skill owned by any other provider
 * (e.g. `aegis-method-pack`) comes from a plugin's own bundled skill tree, so
 * it is grouped under the plugin tier instead of being mistaken for a
 * deployment-provided system skill.
 */
const SYSTEM_BUNDLED_PROVIDERS = new Set(['filesystem', 'dsh-badge'])

/** Map a registry `source` (and the owning provider for bundled skills) onto the management tiers. */
function tierFor(source: string, provider?: string): SkillManagerEntry['tier'] {
  switch (source) {
    case 'bundled':
      // The deployment's own bundled roots (default filesystem provider, the
      // dsh-badge provider) are system skills; any other provider mounting a
      // bundled root is a plugin contribution.
      return provider !== undefined && SYSTEM_BUNDLED_PROVIDERS.has(provider) ? 'system' : 'plugin'
    case 'user-dsh':
    case 'user-agents': return 'user'
    case 'project-dsh':
    case 'project-agents': return 'project'
    // custom (preset-provided dirs) and runtime-registered skills belong to
    // the preset/deployment plane, not to a project workspace.
    default: return 'custom'
  }
}

/** Resolve the viewing scope for a session, mirroring the harness presenter rule. */
async function presenterScopeFor(ctx: Context, sessionId: SessionId | undefined): Promise<({ key: object } & AsyncDisposable) | undefined> {
  if (sessionId === undefined) return undefined
  const live = ctx.get('agents')?.get(sessionId)
  if (live !== undefined) return { key: live, [Symbol.asyncDispose]: async () => {} }
  const presets = ctx.get('agentPresets')
  if (presets === undefined) return undefined
  try {
    const sessions = ctx.get('sessions') as { get(id: SessionId): { header?: { agentPreset?: string } } | undefined } | undefined
    const session = sessions?.get(sessionId)
    // The session header records the preset its composition was created with.
    const presetId = session?.header?.agentPreset
    return presetId === undefined ? undefined : await presets.acquireScope(presetId)
  } catch {
    return undefined
  }
}

/** Parse a SKILL.md's YAML frontmatter into the fields a catalog row needs. */
function parseSkillFrontmatter(content: string): { name: string; description: string; whenToUse?: string } | undefined {
  const lines = content.split('\n')
  if (lines[0]?.trim() !== '---') return undefined
  const end = lines.indexOf('---', 1)
  if (end < 0) return undefined
  let name: string | undefined
  let description: string | undefined
  let whenToUse: string | undefined
  for (const line of lines.slice(1, end)) {
    const match = /^([a-zA-Z-]+):\s*(.*)$/.exec(line.trim())
    if (match === null) continue
    const [, key, raw] = match
    const value = raw.replace(/^["']|["']$/g, '').trim()
    if (key === 'name' && name === undefined) name = value
    else if (key === 'description' && description === undefined) description = value
    else if (key === 'whenToUse' && whenToUse === undefined) whenToUse = value
  }
  if (name === undefined || description === undefined) return undefined
  return { name, description, ...whenToUse === undefined ? {} : { whenToUse } }
}

/** Skill names the Harness accepts (`isSkillName` in `@deepseek-ai/dsh-skill`). */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Validate a SKILL.md the way the Harness's skill loader does, so the editor
 * cannot save a file the catalog will silently drop.
 *
 * The two parsers disagree by design: this plugin reads the frontmatter with a
 * lenient line regex (so a slightly broken file still shows up and can be
 * repaired), while the Harness parses it as strict YAML and **drops the whole
 * skill on any error**, leaving only a warning on the host's stdout. A real
 * incident: a `description` containing `github: ` (colon + space) is not a plain
 * scalar in YAML, so the skill vanished from every agent's catalog while this
 * editor happily displayed it. Validation therefore runs at save time — the last
 * moment where the mistake is still visible — using the same `yaml` parser the
 * Harness uses.
 * @param content - the full SKILL.md text.
 * @returns the problems found; an empty array means the Harness would accept it.
 */
export function validateSkillDocument(content: string): string[] {
  const lines = content.split('\n')
  if ((lines[0] ?? '').replace(/\r$/, '') !== '---') {
    return ['frontmatter 必须以单独一行 `---` 开头（Harness 靠它解析 name/description）']
  }
  let closing = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].replace(/\r$/, '') === '---') {
      closing = index
      break
    }
  }
  if (closing < 0) return ['frontmatter 缺少结束的 `---` 行']
  let data: unknown
  try {
    data = parseYaml(lines.slice(1, closing).join('\n'))
  } catch (error) {
    const position = (error as { linePos?: { line: number; col: number }[] }).linePos?.[0]
    const where = position === undefined ? '' : `（第 ${position.line} 行第 ${position.col} 列）`
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error)
    return [
      `frontmatter 不是合法 YAML${where}：${reason}`,
      '最常见的原因：值里出现「冒号+空格」（例如 `github: ` / `link: ` / `location: `）。'
      + 'YAML 会把它当成映射分隔符，整个技能会被丢弃。给这个值加双引号、并把内部的双引号转义即可。',
    ]
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return ['frontmatter 必须是键值映射（至少含 name 与 description）']
  }
  const record = data as Record<string, unknown>
  const problems: string[] = []
  const name = record.name
  const description = record.description
  if (typeof name !== 'string' || name.trim() === '') {
    problems.push('缺少 name（必须是字符串）')
  } else if (!SKILL_NAME.test(name)) {
    problems.push(`name「${name}」不合法：只允许小写字母、数字与连字符，例如 writing-skills`)
  }
  if (typeof description !== 'string' || description.trim() === '') {
    problems.push('缺少 description（必须是字符串）')
  }
  return problems
}

/** Cap on file-tree nodes and on zip entries, guarding against unbounded memory use. */
const MAX_TREE_NODES = 5000
const MAX_ZIP_ENTRIES = 2000
const MAX_ZIP_BYTES = 100 * 1024 * 1024

function isInsidePath(path: string, root: string): boolean {
  const fromRoot = relative(root, path)
  return fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot)
}

/** Recursively list a directory into a file tree, bounded to regular files and dirs. */
async function listTree(fs: {
  resolve(path: string): Promise<{ displayPath: string; targetKey?: string }>
  listDir(target: { displayPath: string; targetKey?: string }): Promise<{ name: string; type: 'file' | 'directory' | 'other'; target: { displayPath: string; targetKey?: string }; size?: number }[]>
}, path: string, depth: number, budget: { nodes: number }, rootKey: string, maxDepth = 6): Promise<SkillManagerFileNode> {
  const target = await fs.resolve(path)
  const entries = await fs.listDir(target)
  const children: SkillManagerFileNode[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (budget.nodes >= MAX_TREE_NODES) break
    budget.nodes += 1
    // A symlink escaping the skill directory would leak the target's tree
    // (names/sizes/structure); drop any entry whose canonical key leaves the
    // root prefix. Files outside the root stay unreadable regardless.
    const entryKey = entry.target.targetKey ?? entry.target.displayPath
    if (!isInsidePath(entryKey, rootKey)) {
      continue
    }
    if (entry.type === 'directory') {
      const nested: SkillManagerFileNode[] = []
      if (depth < maxDepth) {
        try {
          const subtree = await listTree(fs, entry.target.displayPath, depth + 1, budget, rootKey, maxDepth)
          if (subtree.children !== undefined && subtree.children.length > 0) nested.push(...subtree.children)
        } catch {
          // An unreadable nested directory degrades to an empty directory node.
        }
      }
      children.push({
        name: entry.name,
        kind: 'directory',
        path: entry.target.displayPath,
        ...nested.length > 0 ? { children: nested } : {},
      })
    } else if (entry.type === 'file') {
      children.push({
        name: entry.name,
        kind: 'file',
        path: entry.target.displayPath,
        ...entry.size === undefined ? {} : { size: entry.size },
      })
    }
  }
  return { name: basename(path) || path, kind: 'directory', path, children }
}

/** Join a zip entry path onto a base directory, refusing traversal escapes. */
function nodeJoinSafe(base: string, zipPath: string): string | undefined {
  const parts = zipPath.split(/[\\/]/).filter(Boolean)
  if (parts.some(part => part === '..' || part === '.')) return undefined
  return [base, ...parts].join('/')
}

/** Scan one workspace's `.dsh/skills` directory for project skills (empty workspaces yield none). */
async function scanWorkspaceSkills(wsPath: string): Promise<{
  name: string; description: string; whenToUse?: string; resourcePath: string
}[]> {
  const skillsDir = join(wsPath, '.dsh', 'skills')
  let entries: { name: string; isDirectory(): boolean }[]
  try {
    entries = await nodeReaddir(skillsDir, { withFileTypes: true })
  } catch {
    return [] // no .dsh/skills → empty workspace
  }
  const out: { name: string; description: string; whenToUse?: string; resourcePath: string }[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillDir = join(skillsDir, entry.name)
    let raw: string
    try {
      raw = await nodeReadFile(join(skillDir, 'SKILL.md'), 'utf8')
    } catch {
      continue // no SKILL.md → not a skill
    }
    const parsed = parseSkillFrontmatter(raw)
    if (parsed === undefined) continue
    out.push({ ...parsed, resourcePath: skillDir })
  }
  return out
}

/**
 * Scan one skills root's `.system/` directory for disabled (hidden) skills.
 * The harness filesystem provider ignores `.system`-prefixed directories, so
 * anything under here is currently hidden from discovery; each entry can be
 * restored by renaming it back out of `.system/`.
 * @param skillsRoot - the skills directory (`…/.dsh/skills` or the user root).
 * @returns disabled skill metadata, or an empty array when the root or `.system/` is absent.
 */
async function scanDisabledSkills(skillsRoot: string): Promise<{
  name: string; description: string; whenToUse?: string; resourcePath: string; restorePath: string
}[]> {
  const systemDir = join(skillsRoot, '.system')
  let entries: { name: string; isDirectory(): boolean }[]
  try {
    entries = await nodeReaddir(systemDir, { withFileTypes: true })
  } catch {
    return [] // no .system/ → nothing disabled here
  }
  const out: {
    name: string; description: string; whenToUse?: string; resourcePath: string; restorePath: string
  }[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const hiddenPath = join(systemDir, entry.name)
    let raw: string
    try {
      raw = await nodeReadFile(join(hiddenPath, 'SKILL.md'), 'utf8')
    } catch {
      continue
    }
    const parsed = parseSkillFrontmatter(raw)
    if (parsed === undefined) continue
    out.push({
      name: parsed.name,
      description: parsed.description,
      ...parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse },
      resourcePath: hiddenPath,
      restorePath: join(skillsRoot, entry.name),
    })
  }
  return out
}

/** Whether a path exists (dir or file). */
async function nodeExists(path: string): Promise<boolean> {
  try {
    await nodeAccess(path)
    return true
  } catch {
    return false
  }
}

/** Recursively collect every file under `dir` keyed by its path relative to `root`. */
async function collectDirFiles(dir: string, root: string, out: Map<string, Uint8Array>, budget: { bytes: number }): Promise<void> {
  const entries = await nodeReaddir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const abs = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      await collectDirFiles(abs, root, out, budget)
    } else if (entry.isFile()) {
      const data = new Uint8Array(await nodeReadFile(abs))
      budget.bytes += data.length
      if (budget.bytes > MAX_ZIP_BYTES) {
        throw new Error(`skill directory exceeds the ${Math.round(MAX_ZIP_BYTES / 1024 / 1024)} MB export limit`)
      }
      const rel = abs.slice(root.length + 1)
      out.set(rel, data)
    }
  }
}

/** Build the service and the channel router. */
function buildService(
  ctx: Context,
  registerSection: (rule: SkillSectionRule) => () => void,
  readOnlySources: readonly ReadOnlySkillSource[],
): SkillManagerService {
  const fsOf = (): {
    resolve(path: string): Promise<{ displayPath: string }>
    listDir(target: { displayPath: string }): Promise<{ name: string; type: 'file' | 'directory' | 'other'; target: { displayPath: string }; size?: number }[]>
    readText(target: { displayPath: string }): Promise<string>
    writeText(target: { displayPath: string }, content: string): Promise<unknown>
  } | undefined => {
    const fs = ctx.get('fs') as
      | {
        resolve(path: string): Promise<{ displayPath: string }>
        listDir(target: { displayPath: string }): Promise<{ name: string; type: 'file' | 'directory' | 'other'; target: { displayPath: string }; size?: number }[]>
        readText(target: { displayPath: string }): Promise<string>
        writeText(target: { displayPath: string }, content: string): Promise<unknown>
      }
      | undefined
    return fs
  }

  /**
   * Canonical (realpath) keys of every skill directory surfaced by the last
   * catalog read — including read-only system/preset rows, which may be
   * browsed and exported. Paths are normalized through the fs backend so
   * `..` segments and symlinks cannot smuggle a path past the prefix check.
   */
  let knownSkillDirs: string[] = []

  /** Canonical keys of the writable (project/user) skill directories. */
  let writableSkillDirs: string[] = []

  /** Canonical keys of the writable *skills roots* (`…/.dsh/skills`, the user root). */
  let writableSkillRoots: string[] = []

  /**
   * Canonicalize one path for whitelist comparisons. Prefers the fs backend's
   * targetKey (a realpath), falling back to node:fs realpath (for the
   * node:fs-backed endpoints) and finally the raw path.
   */
  async function resolveCanonical(rawPath: string): Promise<string> {
    const fs = fsOf()
    if (fs !== undefined) {
      try {
        const target = await fs.resolve(rawPath)
        return (target as { targetKey?: string }).targetKey ?? target.displayPath
      } catch {
        // fall through to node realpath
      }
    }
    try {
      return await nodeRealpath(rawPath)
    } catch {
      return rawPath
    }
  }

  /**
   * Resolve a client-supplied path to its canonical key and verify it sits
   * inside one of the given directory prefixes (or equals it).
   * @param requestPath - the raw client path.
   * @param prefixes - canonical directory keys to allow.
   * @param what - action label for the refusal message (`write to`, `delete`, …).
   * @param refusal - the category word for the refusal message (`writable` / `known`).
   * @returns the canonical key of `requestPath`.
   * @throws when the path is outside every allowed prefix.
   */
  async function assertInside(requestPath: string, prefixes: string[], what: string, refusal: string): Promise<string> {
    const key = await resolveCanonical(requestPath)
    const allowed = prefixes.some(prefix => isInsidePath(key, prefix))
    if (!allowed) {
      throw new Error(`refusing to ${what}: path is outside a ${refusal} skill directory (${requestPath})`)
    }
    return key
  }

  /**
   * Canonicalize one directory path for whitelist storage (realpath when the
   * backend exposes it, else the display path).
   */
  const canonicalKey = resolveCanonical

  const service: SkillManagerService = {
    registerSection,
    async list(request) {
      const skills = ctx.get('skills')
      if (skills === undefined) {
        return { skills: [], workspaces: [], complete: false }
      }
      const sessions = ctx.get('sessions') as { get(id: SessionId): { header?: { cwd?: string; agentPreset?: string } } | undefined } | undefined
      const session = request.sessionId === undefined ? undefined : sessions?.get(request.sessionId)
      const cwd = session?.header?.cwd
      await using scopeLease = await presenterScopeFor(ctx, request.sessionId)
      const scope = scopeLease?.key

      const entries: SkillManagerEntry[] = []
      const known: string[] = []
      const writable: string[] = []
      // De-duplicate by (name + resourcePath) so a skill surfaced by several
      // preset layers (the same preset folder copied) is listed once.
      const seen = new Set<string>()
      let complete = true
      // The current session's preset id, for attributing its custom skills.
      const sessionPresetId = session?.header?.agentPreset

      // 1. The current session's layered view (global + preset + user roots):
      //    system, user and custom skills live here. Project skills come from
      //    the workspace enumeration below so every workspace (including empty
      //    ones) appears as an import target.
      const sessionSnapshot = await skills.snapshot({
        ...scope === undefined ? {} : { scope },
        ...cwd === undefined ? {} : { cwd },
      })
      complete = complete && sessionSnapshot.complete
      for (const skill of sessionSnapshot.skills) {
        const tier = tierFor(skill.source, skill.provider)
        if (tier === 'project') continue // provided by workspace enumeration
        const resourcePath = skill.resourceBase !== undefined && skill.resourceBase.kind === 'directory'
          ? skill.resourceBase.path
          : undefined
        const writableSource = skill.source === 'project-dsh' || skill.source === 'project-agents'
          || skill.source === 'user-dsh' || skill.source === 'user-agents'
        if (resourcePath !== undefined) {
          const key = await canonicalKey(resourcePath)
          known.push(key)
          if (writableSource) writable.push(key)
        }
        const key = `${skill.name}|${resourcePath ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        const entry: SkillManagerEntry = {
          name: skill.name,
          description: skill.description,
          ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
          tier,
          readOnly: !writableSource,
          provider: skill.provider,
          modelInvocable: skill.invocation.modelInvocable,
          userInvocable: skill.invocation.userInvocable,
          ...resourcePath === undefined ? {} : { resourcePath },
          // A custom-source skill from the session's own layered view belongs
          // to the session's preset.
          ...tier === 'custom' && sessionPresetId !== undefined ? { preset: sessionPresetId } : {},
        }
        entries.push(entry)
      }

      // 1b. Every registered workspace: scan each `.dsh/skills` directory so
      //     project skills are visible for all workspaces — including empty
      //     ones, which still appear as import targets (sorted after the
      //     non-empty ones). Disabled (`.system/`-hidden) workspace skills are
      //     collected here too.
      const workspaces: SkillManagerWorkspaceRow[] = []
      const writableRoots: string[] = []
      // Disabled (`.system/`-hidden) filesystem skills stay visible in their
      // own tier, marked disabled, so the manager can restore them in place.
      const disabledEntries: SkillManagerEntry[] = []
      // The user skills root, for the disabled rows of the user tier.
      const userHome = process.env.HOME ?? process.env.USERPROFILE ?? ''
      if (userHome !== '') {
        const userRoot = `${userHome}/.dsh/skills`
        writableRoots.push(await canonicalKey(userRoot))
        writableRoots.push(await canonicalKey(`${userHome}/.agents/skills`))
        for (const s of await scanDisabledSkills(userRoot)) {
          disabledEntries.push({
            name: s.name,
            description: s.description,
            ...s.whenToUse === undefined ? {} : { whenToUse: s.whenToUse },
            tier: 'user',
            readOnly: false,
            provider: 'filesystem',
            modelInvocable: true,
            userInvocable: true,
            resourcePath: s.resourcePath,
            restorePath: s.restorePath,
            disabled: true,
          })
        }
        for (const s of await scanDisabledSkills(`${userHome}/.agents/skills`)) {
          disabledEntries.push({
            name: s.name,
            description: s.description,
            ...s.whenToUse === undefined ? {} : { whenToUse: s.whenToUse },
            tier: 'user',
            readOnly: false,
            provider: 'filesystem',
            modelInvocable: true,
            userInvocable: true,
            resourcePath: s.resourcePath,
            restorePath: s.restorePath,
            disabled: true,
          })
        }
      }
      const wsRegistry = ctx.get('workspaceRegistry') as
        | { list(): { id: string; path: string; title: string }[] }
        | undefined
      if (wsRegistry !== undefined) {
        for (const ws of wsRegistry.list()) {
          const wsRoot = `${ws.path}/.dsh/skills`
          writableRoots.push(await canonicalKey(wsRoot))
          for (const s of await scanDisabledSkills(wsRoot)) {
            disabledEntries.push({
              name: s.name,
              description: s.description,
              ...s.whenToUse === undefined ? {} : { whenToUse: s.whenToUse },
              tier: 'project',
              readOnly: false,
              provider: 'filesystem',
              modelInvocable: true,
              userInvocable: true,
              resourcePath: s.resourcePath,
              restorePath: s.restorePath,
              disabled: true,
              workspace: { id: ws.id, title: ws.title, path: ws.path },
            })
          }
          const skills = await scanWorkspaceSkills(ws.path)
          for (const s of skills) {
            const key = `${s.name}|${s.resourcePath}`
            if (seen.has(key)) continue
            seen.add(key)
            const canonical = await canonicalKey(s.resourcePath)
            known.push(canonical)
            writable.push(canonical)
            entries.push({
              name: s.name,
              description: s.description,
              ...s.whenToUse === undefined ? {} : { whenToUse: s.whenToUse },
              tier: 'project',
              readOnly: false,
              provider: 'filesystem',
              modelInvocable: true,
              userInvocable: true,
              resourcePath: s.resourcePath,
              workspace: { id: ws.id, title: ws.title, path: ws.path },
            })
          }
          workspaces.push({ id: ws.id, title: ws.title, path: ws.path, skillCount: skills.length })
        }
        workspaces.sort((a, b) => {
          if (a.skillCount === 0 && b.skillCount > 0) return 1
          if (b.skillCount === 0 && a.skillCount > 0) return -1
          return a.title.localeCompare(b.title)
        })
      }

      // Cold reads retain the exact preset revision until all scoped reads finish.
      const presets = ctx.get('agentPresets')
      if (presets !== undefined) {
        const roster = await presets.list().catch(() => {
          complete = false
          return []
        })
        for (const preset of roster) {
          if (preset.broken !== undefined) { complete = false; continue }
          try {
            await using lease = await presets.acquireScope(preset.id)
            const presetSnapshot = await skills.snapshot({
              scope: lease.key,
              ...cwd === undefined ? {} : { cwd },
            })
            complete = complete && presetSnapshot.complete
            for (const skill of presetSnapshot.skills) {
              const tier = tierFor(skill.source, skill.provider)
              if (tier !== 'custom') continue // only the preset-provided layer
              const resourcePath = skill.resourceBase !== undefined && skill.resourceBase.kind === 'directory'
                ? skill.resourceBase.path
                : undefined
              if (resourcePath !== undefined) known.push(await canonicalKey(resourcePath))
              const key = `${skill.name}|${resourcePath ?? ''}`
              if (seen.has(key)) continue
              seen.add(key)
              entries.push({
                name: skill.name,
                description: skill.description,
                ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
                tier,
                readOnly: true, // preset-provided skills are never editable in place
                provider: skill.provider,
                modelInvocable: skill.invocation.modelInvocable,
                userInvocable: skill.invocation.userInvocable,
                preset: preset.id,
                ...resourcePath === undefined ? {} : { resourcePath },
              })
            }
          } catch {
            complete = false
          }
        }
      }

      // The invocation catalog keeps one winner per name. The settings page also
      // lists each explicitly configured read-only filesystem source individually.
      for (const { provider, directory } of readOnlySources) {
        const source = new FileSystemSkillProvider(ctx, { signal: new AbortController().signal, invalidate() {} }, {
          providerName: provider, includeDefaultRoots: false, customSkillDirs: [directory], watch: false,
        })
        try {
          const result = await source.list({})
          if (!Array.isArray(result)) complete = complete && result.complete
          const listed = new Set(entries.filter(row => row.provider === provider).map(row => row.name))
          for (const skill of Array.isArray(result) ? result : result.candidates) {
            if (listed.has(skill.name)) continue
            const resourcePath = skill.resourceBase?.kind === 'directory' ? skill.resourceBase.path : undefined
            if (resourcePath !== undefined) known.push(await canonicalKey(resourcePath))
            listed.add(skill.name)
            entries.push({
              name: skill.name,
              description: skill.description,
              ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
              tier: 'custom',
              readOnly: true,
              provider,
              modelInvocable: skill.invocation.modelInvocable,
              userInvocable: skill.invocation.userInvocable,
              ...(resourcePath === undefined ? {} : { resourcePath }),
            })
          }
        } finally {
          await source.dispose()
        }
      }

      // Replace the whitelist snapshots (deduplicated) after a successful read.
      knownSkillDirs = [...new Set(known)]
      writableSkillDirs = [...new Set(writable)]
      writableSkillRoots = [...new Set(writableRoots)]
      // Disabled skills stay in their tier, deduplicated by name.
      for (const row of disabledEntries) {
        if (seen.has(`${row.name}|${row.resourcePath ?? ''}`)) continue
        entries.push(row)
      }
      return {
        skills: entries,
        workspaces,
        complete,
      }
    },

    async files(request) {
      const fs = fsOf()
      if (fs === undefined) throw new Error('filesystem service is unavailable')
      // Browsing is allowed for any known skill directory (read-only rows included).
      const key = await assertInside(request.path, knownSkillDirs, 'list files in', 'known')
      return { root: await listTree(fs, key, 0, { nodes: 0 }, key) }
    },

    async read(request) {
      const fs = fsOf()
      if (fs === undefined) throw new Error('filesystem service is unavailable')
      // Reading is allowed for any known skill directory (read-only rows included).
      const key = await assertInside(request.path, knownSkillDirs, 'read from', 'known')
      const target = await fs.resolve(key)
      return { content: await fs.readText(target) }
    },

    async write(request) {
      // Only paths inside a non-read-only skill directory (collected by the
      // last catalog read) may be written; system/bundled and unknown paths
      // are refused before touching the filesystem. The path is canonicalized
      // first so `..` segments and symlinks cannot escape the whitelist.
      const key = await assertInside(request.path, writableSkillDirs, 'write to', 'writable')
      const fs = fsOf()
      if (fs === undefined) throw new Error('filesystem service is unavailable')
      // Save-time gate for SKILL.md: the Harness drops a skill whose frontmatter
      // does not parse, with nothing but a host-stdout warning, so an unvalidated
      // save can make a whole skill disappear from every agent's catalog. Other
      // files in the directory (references, scripts) are written as-is.
      if (key.split(/[\\/]/).pop() === 'SKILL.md') {
        const problems = validateSkillDocument(request.content)
        if (problems.length > 0) {
          throw new Error('SKILL.md 校验未通过，未写入：\n- ' + problems.join('\n- '))
        }
      }
      const target = await fs.resolve(key)
      await fs.writeText(target, request.content)
      return { ok: true }
    },

    async importSkill(request) {
      // Resolve the target skills directory from the requested tier.
      let targetDir: string
      if (request.tier === 'user') {
        const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
        if (home === '') throw new Error('cannot resolve the user home directory')
        targetDir = `${home}/.dsh/skills`
      } else if (request.workspacePath !== undefined) {
        // Only a workspace the registry actually knows may be an import target;
        // otherwise any caller could plant files under an arbitrary path.
        const wsRegistry = ctx.get('workspaceRegistry') as
          | { list(): { id: string; path: string; title: string }[] }
          | undefined
        const registered = wsRegistry === undefined
          ? []
          : await Promise.all(wsRegistry.list().map(async (ws) => ({
            id: ws.id,
            path: await canonicalKey(ws.path),
          })))
        const want = await canonicalKey(request.workspacePath)
        if (!registered.some(ws => ws.path === want)) {
          throw new Error(`refusing to import into an unregistered workspace: ${request.workspacePath}`)
        }
        targetDir = `${want}/.dsh/skills`
      } else {
        throw new Error('cannot resolve the workspace directory for import')
      }
      // Bound the payload before decoding: a huge or highly-compressible zip
      // must not be able to exhaust the host process's memory. The entry
      // count and declared uncompressed sizes are enforced through
      // unzipSync's filter, which runs per entry *before* that entry is
      // inflated — so the caps hold even under pathological compression.
      if (request.zipBase64.length > 8 * 1024 * 1024) {
        throw new Error('uploaded package exceeds the 8 MB size limit')
      }
      const bytes = Buffer.from(request.zipBase64, 'base64')
      let seenEntries = 0
      let declaredBytes = 0
      const entries = unzipSync(new Uint8Array(bytes), {
        filter(entry) {
          seenEntries += 1
          if (seenEntries > MAX_ZIP_ENTRIES) {
            throw new Error(`uploaded package has too many entries (${seenEntries} > ${MAX_ZIP_ENTRIES})`)
          }
          declaredBytes += entry.originalSize
          if (declaredBytes > MAX_ZIP_BYTES) {
            throw new Error(`uploaded package expands beyond the ${Math.round(MAX_ZIP_BYTES / 1024 / 1024)} MB limit`)
          }
          return true
        },
      })
      // Normalize each zip entry: drop a leading `skills/` (or `.agents/skills/`)
      // prefix and macOS noise, then classify the skill it belongs to.
      const normalized = new Map<string, Uint8Array>()
      const skillNameByEntry = new Map<string, string>()
      for (const [zipPath, data] of Object.entries(entries)) {
        if (zipPath.includes('__MACOSX')) continue
        const raw = zipPath.split(/[\\/]/).filter(Boolean)
        if (raw.some(part => part === '..' || part === '.')) continue
        let parts = raw
        if (parts[0] === 'skills' || parts[0] === '.agents' || parts[0] === '.dsh') {
          // `skills/<name>/…`, `.agents/skills/<name>/…`, `.dsh/skills/<name>/…`
          parts = parts.slice(parts[0] === 'skills' ? 1 : parts[0] === '.dsh' || parts[1] === 'skills' ? 2 : 1)
        }
        if (parts.length === 0) continue
        const normalizedPath = parts.join('/')
        // Skip non-SKILL.md top-level noise (a loose README at the archive root).
        if (parts.length === 1 && parts[0] !== 'SKILL.md' && !parts[0]!.endsWith('.md')) continue
        normalized.set(normalizedPath, data)
        const fileName = parts[parts.length - 1] ?? ''
        if (fileName === 'SKILL.md') {
          // <name>/SKILL.md → skill name; bare SKILL.md → read the frontmatter name.
          if (parts.length >= 2) skillNameByEntry.set(normalizedPath, parts[0]!)
          else skillNameByEntry.set(normalizedPath, '')
        } else if (parts.length === 1 && fileName.endsWith('.md')) {
          // A single loose .md file is a one-file skill named after the file.
          skillNameByEntry.set(normalizedPath, fileName.slice(0, -3))
        }
      }
      // Resolve bare SKILL.md names from their frontmatter.
      for (const [entryPath, name] of [...skillNameByEntry]) {
        if (name !== '') continue
        const raw = normalized.get(entryPath)
        if (raw === undefined) continue
        const parsed = parseSkillFrontmatter(new TextDecoder().decode(raw))
        if (parsed !== undefined) skillNameByEntry.set(entryPath, parsed.name)
      }
      const imported: string[] = []
      const validName = (name: string): boolean => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
      for (const name of skillNameByEntry.values()) {
        if (!validName(name)) continue
        if (imported.includes(name)) continue
        imported.push(name)
      }
      if (imported.length === 0) {
        const sample = [...normalized.keys()].slice(0, 5).join(', ')
        throw new Error(`no valid skills found in the uploaded package (expected <skill>/SKILL.md entries); archive contains: ${sample || '(empty)'}`)
      }
      await nodeMkdir(targetDir, { recursive: true })
      // Extract every normalized entry belonging to an imported skill.
      const seen = new Set<string>()
      for (const [entryPath, data] of normalized) {
        const parts = entryPath.split('/').filter(Boolean)
        const skillName = skillNameByEntry.get(entryPath)
        if (skillName === undefined || !imported.includes(skillName)) continue
        // A single top-level file (bare SKILL.md or <name>.md) becomes the
        // skill's own file inside <skill>/.
        if (parts.length === 1) {
          const outPath = nodeJoinSafe(targetDir, `${skillName}/${parts[0]}`)
          if (outPath === undefined) continue
          await nodeMkdir(outPath.split('/').slice(0, -1).join('/'), { recursive: true })
          await nodeWriteFile(outPath, data)
          continue
        }
        const outPath = nodeJoinSafe(targetDir, entryPath)
        if (outPath === undefined) continue
        if (seen.has(entryPath)) continue
        seen.add(entryPath)
        await nodeMkdir(outPath.split('/').slice(0, -1).join('/'), { recursive: true })
        await nodeWriteFile(outPath, data)
      }
      return { imported }
    },

    async exportSkill(request) {
      // Exporting is allowed for any known skill directory (read-only rows
      // included), canonicalized before the recursive node:fs walk.
      const key = await assertInside(request.path, knownSkillDirs, 'export', 'known')
      const files = new Map<string, Uint8Array>()
      await collectDirFiles(key, key, files, { bytes: 0 })
      const zipped = zipSync(Object.fromEntries(files), { level: 6 })
      const base = basename(key) || 'skill'
      return {
        zipBase64: Buffer.from(zipped).toString('base64'),
        fileName: `${base}.zip`,
      }
    },

    async deleteSkill(request) {
      // Only writable skill directories (project/user) may be deleted. The
      // request names the skill directory itself, so it matches the prefix
      // exactly (or sits under it). The path is canonicalized first so `..`
      // segments and symlinks cannot make node:rm delete outside the whitelist.
      const key = await assertInside(request.path, writableSkillDirs, 'delete', 'writable')
      await nodeRm(key, { recursive: true, force: true })
      return { ok: true }
    },

    async toggleSkill(request) {
      // Only writable (project/user) filesystem skills may be hidden or
      // restored; provider-backed (system/preset/plugin) skills are read-only
      // and keep whatever state the deployment gives them.
      const key = await resolveCanonical(request.path)
      const base = basename(key)
      if (base === '' || base === '.system') {
        throw new Error(`cannot toggle a skill directory named "${base}"`)
      }
      const parent = await resolveCanonical(dirname(key))
      const systemDir = join(parent, '.system')
      const hidden = join(systemDir, base)

      if (request.enable) {
        // Restore: `…/.system/<name>` → `…/<name>`. The parent (`…/<skills>`)
        // must be a writable skills root — a hidden skill may no longer be in
        // the visible-skill whitelist after a catalog refresh, so the root is
        // the stable boundary. The hidden dir must actually exist.
        if (!writableSkillRoots.some(root => isInsidePath(parent, root))) {
          throw new Error(`refusing to restore outside a writable skill directory: ${request.path}`)
        }
        if (!(await nodeExists(hidden))) return { ok: true } // already visible
        await nodeRename(hidden, key)
        return { ok: true }
      }
      // Disable: `…/<name>` → `…/.system/<name>`; the visible dir must be in
      // the writable whitelist, and the hidden target must not already exist.
      if (!writableSkillDirs.some(prefix => isInsidePath(key, prefix))) {
        throw new Error(`refusing to disable outside a writable skill directory: ${request.path}`)
      }
      if (await nodeExists(hidden)) return { ok: true } // already hidden
      await nodeMkdir(systemDir, { recursive: true })
      await nodeRename(key, hidden)
      return { ok: true }
    },
  }
  return service
}

/**
 * Mount the catalog service and the `/skill-manager` channel.
 * @param ctx - plugin context.
 */
/** Logical channel this plugin owns; the browser addresses it as `<channel>/<endpoint>`. */
const SKILL_MANAGER_CHANNEL = 'skill-manager'

/** Endpoints this channel serves; each becomes one exact Fetch route under `/api`. */
const SKILL_MANAGER_ENDPOINTS = [
  'list', 'files', 'read', 'write', 'importSkill', 'exportSkill', 'deleteSkill', 'toggleSkill',
] as const

export const inject = ['connection']

export function apply(ctx: Context, config: Config = {}): void {
  const { readOnlySources = [], ...presentation } = config
  const registeredSections = new Map<string, SkillSectionRule>()
  const registerSection = (rule: SkillSectionRule): (() => void) => {
    registeredSections.set(rule.id, rule)
    return () => {
      if (registeredSections.get(rule.id) === rule) registeredSections.delete(rule.id)
    }
  }
  const resolvedSections = (): readonly SkillSectionRule[] => {
    const byId = new Map<string, SkillSectionRule>()
    for (const rule of config.sections ?? []) byId.set(rule.id, rule)
    for (const rule of registeredSections.values()) byId.set(rule.id, rule)
    return [...byId.values()]
      .map((rule, index) => ({ rule, index }))
      .sort((a, b) => (a.rule.order ?? 100) - (b.rule.order ?? 100) || a.index - b.index)
      .map(entry => entry.rule)
  }

  ctx.on('webserver/index-inject', table => {
    table.push({ kind: 'global', name: '__DSH_SKILL_MANAGER_OPTIONS__', value: { ...presentation, sections: resolvedSections() } })
  })
  const service = buildService(ctx, registerSection, readOnlySources)
  ctx.provide('skillManager', service)

  const connection = ctx.get('connection') as HostConnectionHandle
  // Dedicated plugin channels ride the shared `/api` carrier. The generic RPC
  // caller's channel must be a single path segment, so the logical channel
  // travels as the endpoint's first segment instead. Exact Fetch routes only
  // touch this service's own route table, and the carrier applies trusted-host
  // and browser authentication before these handlers run — which also leaves
  // the single-slot `/api` interceptor to the Typert gateway.
  /** Serve one decoded endpoint from a JSON RPC envelope. */
  async function dispatchSkillManager(endpoint: string, payload: unknown): Promise<RpcResult<unknown>> {
    const request = (payload ?? {}) as Record<string, unknown>
    try {
      let value: unknown
      switch (endpoint) {
        case 'list': value = await service.list(request as unknown as SkillManagerListRequest); break
        case 'files': value = await service.files(request as unknown as SkillManagerFilesRequest); break
        case 'read': value = await service.read(request as unknown as SkillManagerReadRequest); break
        case 'write': value = await service.write(request as unknown as SkillManagerWriteRequest); break
        case 'importSkill': value = await service.importSkill(request as unknown as SkillManagerImportRequest); break
        case 'exportSkill': value = await service.exportSkill(request as unknown as SkillManagerExportRequest); break
        case 'deleteSkill': value = await service.deleteSkill(request as unknown as SkillManagerDeleteRequest); break
        case 'toggleSkill': value = await service.toggleSkill(request as unknown as SkillManagerToggleRequest); break
        default:
          return {
            ok: false,
            error: {
              code: 'internal',
              message: `unknown skillManager endpoint "${endpoint}"`,
              details: {},
            },
          } as RpcResult<unknown>
      }
      return { ok: true, value } as RpcResult<unknown>
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'internal',
          message: error instanceof Error ? error.message : String(error),
          details: { endpoint },
        },
      } as RpcResult<unknown>
    }  }

  for (const endpoint of SKILL_MANAGER_ENDPOINTS) {
    const method = `${SKILL_MANAGER_CHANNEL}/${endpoint}`
    ctx.effect(() => connection.fetch.register({
      path: `${API_PATH}/${method}`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
          return new Response('content type must be application/json', { status: 415 })
        }
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return new Response('invalid JSON', { status: 400 })
        }
        const envelope = clientRequestSchema.safeParse(body)
        if (!envelope.success || envelope.data.method !== method) {
          return new Response('invalid RPC envelope', { status: 400 })
        }
        return Response.json({
          type: 'server-response',
          rpcId: envelope.data.rpcId,
          result: await dispatchSkillManager(endpoint, envelope.data.payload),
        })
      },
    }), `dsh-skill-manager: ${method}`)
  }
}
