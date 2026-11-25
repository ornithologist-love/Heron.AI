/**
 * Skill Manager settings-page store: catalog fetch state, workspace grouping
 * for project skills, and the file-tree / read / write operations over skill
 * directories. The host stays the single fact source — every read goes
 * through the `/skill-manager` wire endpoints and the page re-renders from
 * the next snapshot. The settings shell owns page open/close; this store owns
 * catalog rows, expansion state, and the editor lifecycle.
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { produce } from 'immer'

/** Minimal local snapshot store; keeps the plugin independent of the runtime package's browser module row. */
export interface SnapshotStore<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
  update(mutator: (draft: T) => void): void
  set(next: T): void
}

function createSnapshotStore<T>(initial: T): SnapshotStore<T> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    update(mutator) {
      const next = produce(snapshot, mutator)
      if (next !== snapshot) {
        snapshot = next
        notify()
      }
    },
    set(next) {
      if (next !== snapshot) {
        snapshot = next
        notify()
      }
    },
  }
}

/** One catalog row as served by the host `skillManager.list` endpoint. */
export interface SkillManagerEntry {
  /** Kebab-case skill identifier. */
  name: string
  /** Short routing description. */
  description: string
  /** Optional extra routing guidance. */
  whenToUse?: string
  /** Grouping bucket: system / user / project / custom / plugin. */
  tier: 'system' | 'user' | 'project' | 'custom' | 'plugin'
  /** Whether the row is read-only (system skills are never editable). */
  readOnly: boolean
  /** Provider that owns this winning skill body. */
  provider: string
  /** Whether the model catalog lists it (false = user-only invocation). */
  modelInvocable: boolean
  /** Whether the user may invoke it explicitly (e.g. `/name`). */
  userInvocable: boolean
  /** Absolute path of the skill directory (resourceBase), when provider-backed. */
  resourcePath?: string
  /** Whether this filesystem skill is disabled (hidden under `.system/`). */
  disabled?: boolean
  /** Visible directory path passed to toggleSkill to restore a disabled skill. */
  restorePath?: string
  /** Project skill rows carry their owning workspace attribution. */
  workspace?: SkillManagerWorkspace
  /** Preset-provided (custom-source) rows carry their owning preset id. */
  preset?: string
}

/** Workspace attribution of one project skill row. */
export interface SkillManagerWorkspace {
  /** Durable workspace record id, when the registry knows this path. */
  id?: string
  /** Display title: the registered workspace title, else the project dir basename. */
  title: string
  /** The workspace root directory (project root). */
  path: string
}

/** One node of a skill directory file tree. */
export interface SkillManagerFileNode {
  /** Entry name (basename). */
  name: string
  /** Directory or regular file. */
  kind: 'directory' | 'file'
  /** Absolute path of this node. */
  path: string
  /** Byte size, when known (files). */
  size?: number
  /** Nested children, when a directory. */
  children?: SkillManagerFileNode[]
}

/** One workspace row in the catalog, including workspaces without skills. */
export interface SkillManagerWorkspaceRow {
  /** Durable workspace record id. */
  id?: string
  /** Display title. */
  title: string
  /** The workspace root directory. */
  path: string
  /** Number of project skills this workspace currently provides. */
  skillCount: number
}

/** One project skill grouped under its workspace. */
export interface WorkspaceSkillGroup {
  /** Workspace display title. */
  title: string
  /** Durable workspace id, when known. */
  id?: string
  /** The workspace root directory (import target). */
  path: string
  /** The project skills owned by this workspace (empty for blank workspaces). */
  skills: SkillManagerEntry[]
}

/** One preset-provided skill grouped under its owning preset. */
export interface PresetSkillGroup {
  /** Preset id. */
  id: string
  /** The custom-source skills this preset provides. */
  skills: SkillManagerEntry[]
}

/** One plugin-provided skill grouped under its owning provider. */
export interface PluginSkillGroup {
  /** Provider id (e.g. `aegis-method-pack`). */
  provider: string
  /** The bundled-source skills this plugin provider contributes. */
  skills: SkillManagerEntry[]
}

/** The editor view for one opened file. */
export interface SkillFileEditor {
  /** Absolute path being edited. */
  path: string
  /** Display name (basename). */
  name: string
  /** Whether this file may be written (false for system skill paths). */
  writable: boolean
  /** Current content in the editor. */
  content: string
  /** Saved content at last read; dirty when they diverge. */
  saved: string
  /** Whether a write is in flight. */
  saving: boolean
  /** Non-empty when the last write failed. */
  saveError: string | null
}

/** The catalog view held by the settings page. */
export interface SkillManagerState {
  /** Rows grouped into their display tiers. */
  byTier: {
    system: SkillManagerEntry[]
    user: SkillManagerEntry[]
    project: SkillManagerEntry[]
    custom: SkillManagerEntry[]
    plugin: SkillManagerEntry[]
  }
  /** Project skills grouped by workspace, in first-seen workspace order. */
  projectGroups: WorkspaceSkillGroup[]
  /** Preset-provided skills grouped by preset, in first-seen preset order. */
  presetGroups: PresetSkillGroup[]
  /** Plugin-provided skills grouped by provider, in first-seen provider order. */
  pluginGroups: PluginSkillGroup[]
  /** Non-empty while an enable/disable operation is in flight. */
  toggling: string | null
  /** Whether a catalog fetch is in flight. */
  loading: boolean
  /** Non-empty when the last catalog fetch failed. */
  error: string | null
  /** Whether discovery completed within a stable revision. */
  complete: boolean
  /** Loaded file trees keyed by resource directory. */
  fileTrees: Record<string, SkillManagerFileNode | 'loading'>
  /** The open file editor, when one is active. */
  editor: SkillFileEditor | null
  /** Non-empty while an import/export/delete operation is in flight. */
  busy: string | null
}

/** Bridge the wire endpoints onto the page state. */
export class SkillManagerController {
  /**
   * @param connection - the connection handle whose generic rpc channel reaches the host endpoints.
   * @param store - the page store this controller mutates.
   */
  constructor(
    private readonly connection: ConnectionHandle,
    private readonly store: SkillManagerStore,
  ) {}

  /**
   * Call one `/skill-manager` endpoint (through the shared `/api` carrier) and fold its value into the store.
   * @param endpoint - endpoint name (`list` / `files` / `read` / `write`).
   * @param payload - JSON request payload.
   * @returns the wire value on success, or an error message on failure.
   */
  private async call<T>(endpoint: string, payload: Record<string, unknown>): Promise<T | { error: string }> {
    try {
      // The logical channel rides the shared `/api` carrier as the endpoint's
      // first segment: the generic caller's channel must stay one path segment.
      const result = await this.connection.rpc.call('/api', `skill-manager/${endpoint}`, payload)
      if (result.ok) return result.value as T
      // Surface the host's real message so failures are diagnosable.
      const error = result.error as { message?: unknown }
      return { error: typeof error?.message === 'string' ? error.message : 'endpoint failed' }
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'endpoint failed' }
    }
  }

  /**
   * Fetch the catalog for a session and fold it into the store.
   * @param sessionId - session whose scope and project cwd select the catalog; omitted reads the global layer.
   */
  /**
   * Fetch the catalog for a session and fold it into the store.
   * @param sessionId - session whose scope and project cwd select the catalog; omitted reads the global layer.
   * @param silent - when true, refresh data without toggling the loading flag,
   *   so already-mounted expand/collapse state survives the data replacement.
   */
  async refresh(sessionId: unknown, silent = false): Promise<void> {
    this.store.update((draft) => {
      if (!silent) draft.loading = true
      draft.error = null
    })
    const value = await this.call<{
      skills?: SkillManagerEntry[]
      workspaces?: SkillManagerWorkspaceRow[]
      complete?: boolean
    }>('list', sessionId === undefined ? {} : { sessionId })
    this.store.update((draft) => {
      draft.loading = false
      if ('error' in value) {
        draft.error = value.error
        return
      }
      draft.byTier = groupByTier(value.skills ?? [])
      draft.projectGroups = groupByWorkspace(value.skills ?? [], value.workspaces ?? [])
      draft.presetGroups = groupByPreset(value.skills ?? [])
      draft.pluginGroups = groupByProvider(value.skills ?? [])
      draft.complete = value.complete === true
    })
  }

  /**
   * Load the file tree of one skill directory into the store.
   * @param path - the skill directory's absolute path.
   */
  async loadFileTree(path: string): Promise<void> {
    this.store.update((draft) => {
      draft.fileTrees[path] = 'loading'
    })
    const value = await this.call<{ root: SkillManagerFileNode }>('files', { path })
    this.store.update((draft) => {
      if ('error' in value) {
        delete draft.fileTrees[path]
        return
      }
      draft.fileTrees[path] = value.root
    })
  }

  /**
   * Open a file in the editor.
   * @param path - absolute file path.
   * @param name - display basename.
   * @param writable - whether writes are allowed.
   */
  async openFile(path: string, name: string, writable: boolean): Promise<void> {
    this.store.update((draft) => {
      draft.editor = { path, name, writable, content: '', saved: '', saving: false, saveError: null }
    })
    const value = await this.call<{ content: string }>('read', { path })
    this.store.update((draft) => {
      if (draft.editor === null || draft.editor.path !== path) return
      if ('error' in value) {
        draft.editor.saveError = value.error
        return
      }
      draft.editor.content = value.content
      draft.editor.saved = value.content
    })
  }

  /** Update the editor's current content (dirty tracking against saved). */
  editContent(content: string): void {
    this.store.update((draft) => {
      if (draft.editor === null) return
      draft.editor.content = content
    })
  }

  /**
   * Save the editor's current content back to the file.
   */
  async saveFile(): Promise<void> {
    const editor = this.store.getSnapshot().editor
    if (editor === null || editor.saving) return
    this.store.update((draft) => {
      if (draft.editor === null) return
      draft.editor.saving = true
      draft.editor.saveError = null
    })
    const value = await this.call<{ ok: true }>('write', { path: editor.path, content: editor.content })
    this.store.update((draft) => {
      if (draft.editor === null || draft.editor.path !== editor.path) return
      draft.editor.saving = false
      if ('error' in value) {
        draft.editor.saveError = value.error
        return
      }
      draft.editor.saved = draft.editor.content
    })
  }

  /** Close the open editor. */
  closeEditor(): void {
    this.store.update((draft) => {
      draft.editor = null
    })
  }

  /**
   * Import skills from an uploaded zip into a tier's skills directory.
   * @param zipBase64 - the zip payload.
   * @param tier - target tier (`user` or `workspace`).
   * @param workspacePath - the workspace root for `tier: 'workspace'`.
   * @returns the imported skill names, or `{ error }` on failure.
   */
  async importSkill(
    zipBase64: string,
    tier: 'user' | 'workspace',
    workspacePath?: string,
  ): Promise<string[] | { error: string }> {
    this.store.update((draft) => { draft.busy = 'import' })
    const value = await this.call<{ imported: string[] }>('importSkill', {
      zipBase64,
      tier,
      ...tier === 'workspace' && workspacePath !== undefined ? { workspacePath } : {},
    })
    this.store.update((draft) => { draft.busy = null })
    return 'error' in value ? value : value.imported
  }

  /**
   * Export one skill directory as a downloadable zip.
   * @param path - the skill directory.
   * @returns the zip base64 and file name, or `{ error }` on failure.
   */
  async exportSkill(path: string): Promise<{ zipBase64: string; fileName: string } | { error: string }> {
    this.store.update((draft) => { draft.busy = `export:${path}` })
    const value = await this.call<{ zipBase64: string; fileName: string }>('exportSkill', { path })
    this.store.update((draft) => { draft.busy = null })
    return value
  }

  /**
   * Delete one skill directory.
   * @param path - the skill directory.
   * @returns `true` on success, or `{ error }` on failure.
   */
  async deleteSkill(path: string): Promise<true | { error: string }> {
    this.store.update((draft) => { draft.busy = `delete:${path}` })
    const value = await this.call<{ ok: true }>('deleteSkill', { path })
    this.store.update((draft) => { draft.busy = null })
    return 'error' in value ? value : true
  }

  /**
   * Enable or disable a writable filesystem skill (rename into/out of
   * `.system/`). Disabled skills vanish from discovery until restored.
   * @param path - the skill directory path (`.system/` path when restoring).
   * @param enable - `true` restores, `false` hides.
   * @returns `true` on success, or `{ error }` on failure.
   */
  async toggleSkill(path: string, enable: boolean): Promise<true | { error: string }> {
    this.store.update((draft) => { draft.toggling = `${enable ? 'enable' : 'disable'}:${path}` })
    const value = await this.call<{ ok: true }>('toggleSkill', { path, enable })
    this.store.update((draft) => { draft.toggling = null })
    return 'error' in value ? value : true
  }

}

/** The page store type. */
export type SkillManagerStore = SnapshotStore<SkillManagerState>

/** Build the empty page store. */
export function createSkillManagerStore(): SkillManagerStore {
  return createSnapshotStore<SkillManagerState>({
    byTier: { system: [], user: [], project: [], custom: [], plugin: [] },
    projectGroups: [],
    presetGroups: [],
    pluginGroups: [],
    toggling: null,
    loading: false,
    error: null,
    complete: true,
    fileTrees: {},
    editor: null,
    busy: null,
  })
}

/** Bucket rows into their tiers. */
export function groupByTier(rows: readonly SkillManagerEntry[]): SkillManagerState['byTier'] {
  const byTier: SkillManagerState['byTier'] = { system: [], user: [], project: [], custom: [], plugin: [] }
  for (const row of rows) byTier[row.tier].push(row)
  return byTier
}

/**
 * Group project rows by workspace, including blank workspaces from the
 * catalog's workspace rows (they appear after non-empty ones as import
 * targets).
 * @param rows - project skill rows.
 * @param workspaceRows - every registered workspace (blank ones included).
 */
export function groupByWorkspace(
  rows: readonly SkillManagerEntry[],
  workspaceRows: readonly SkillManagerWorkspaceRow[] = [],
): WorkspaceSkillGroup[] {
  const groups: WorkspaceSkillGroup[] = []
  const byPath = new Map<string, WorkspaceSkillGroup>()
  // Non-empty workspace rows first (host already sorts them that way), then
  // any project rows not covered by a workspace row.
  for (const ws of workspaceRows) {
    if (ws.skillCount === 0) continue
    const group: WorkspaceSkillGroup = {
      title: ws.title,
      ...ws.id === undefined ? {} : { id: ws.id },
      path: ws.path,
      skills: [],
    }
    byPath.set(ws.path, group)
    groups.push(group)
  }
  for (const row of rows) {
    if (row.tier !== 'project') continue
    const path = row.workspace?.path
    let group = path === undefined ? undefined : byPath.get(path)
    if (group === undefined) {
      group = {
        title: row.workspace?.title ?? 'project',
        ...row.workspace?.id === undefined ? {} : { id: row.workspace.id },
        path: path ?? '',
        skills: [],
      }
      byPath.set(path ?? group.title, group)
      groups.push(group)
    }
    group.skills.push(row)
  }
  // Blank workspaces (import targets) sort after the non-empty ones.
  for (const ws of workspaceRows) {
    if (ws.skillCount > 0) continue
    const group: WorkspaceSkillGroup = {
      title: ws.title,
      ...ws.id === undefined ? {} : { id: ws.id },
      path: ws.path,
      skills: [],
    }
    byPath.set(ws.path, group)
    groups.push(group)
  }
  return groups
}

/**
 * Group preset-provided (custom) rows by their owning preset, in first-seen order.
 * Custom roots a deployment mounts outside every preset are grouped by their
 * provider instead, so they are listed rather than dropped.
 */
export function groupByPreset(rows: readonly SkillManagerEntry[]): PresetSkillGroup[] {
  const groups: PresetSkillGroup[] = []
  const index = new Map<string, PresetSkillGroup>()
  for (const row of rows) {
    if (row.tier !== 'custom') continue
    const id = row.preset ?? row.provider
    let group = index.get(id)
    if (group === undefined) {
      group = { id, skills: [] }
      index.set(id, group)
      groups.push(group)
    }
    group.skills.push(row)
  }
  return groups
}

/** Group plugin-provided (bundled, non-system provider) rows by their owning provider, in first-seen order. */
export function groupByProvider(rows: readonly SkillManagerEntry[]): PluginSkillGroup[] {
  const groups: PluginSkillGroup[] = []
  const index = new Map<string, PluginSkillGroup>()
  for (const row of rows) {
    if (row.tier !== 'plugin') continue
    const provider = row.provider
    let group = index.get(provider)
    if (group === undefined) {
      group = { provider, skills: [] }
      index.set(provider, group)
      groups.push(group)
    }
    group.skills.push(row)
  }
  return groups
}
