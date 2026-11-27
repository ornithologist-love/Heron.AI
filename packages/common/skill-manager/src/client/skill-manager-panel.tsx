/**
 * Skill Manager panel. Each row expands into its file tree and opens
 * the editor with the access allowed by its source.
 */

import React, { useEffect, useState } from 'react'
import type {} from '../presentation-options.ts'
import {
  IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconCodeOutlineRegular,
  IconFolderOpenOutlineRegular, IconQuestionOutlineRegular, IconRefreshOutlineRegular,
  IconSearchOutlineRegular, Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { SkillManagerKey } from './locales.ts'
import type {
  SkillManagerController, SkillManagerEntry, SkillManagerFileNode, SkillManagerState,
  PresetSkillGroup, PluginSkillGroup, WorkspaceSkillGroup,
} from './store.ts'
import { SkillManagerEditor } from './skill-manager-editor.tsx'
import styles from './skill-manager-panel.module.css'

/** The inject face the slot registration binds for the Skills tab. */
export interface SkillManagerInjected {
  /** Wire operations through the host endpoints. */
  controller: SkillManagerController
  /** uSES hook over the shared page state. */
  usePanel: SnapshotSelectorHook<SkillManagerState>
  /** Re-fetch the catalog. */
  refresh: () => void
  /** Re-fetch without toggling the loading flag (keeps expand/collapse state). */
  refreshSilent: () => void
  /** Page copy. */
  t: Translate<SkillManagerKey>
}

/** Props delivered by the slot outlet: the inject face spread flat. */
export type SkillManagerPanelProps = Partial<SkillManagerInjected>

/** Shared per-row state threaded from the panel's usePanel subscription. */
interface RowShared {
  /** File trees by resource directory; 'loading' while a fetch is in flight. */
  fileTrees: SkillManagerState['fileTrees']
  /** Re-fetch the catalog after a mutation (delete/import). */
  refreshAfterMutation: () => void
  /** Surface an error message at the page level. */
  reportError: (message: string) => void
  /** Keep matching groups visible while searching. */
  searching: boolean
  t: SkillManagerInjected['t']
  controller: SkillManagerController
}

/** One skill row with its expandable file tree and action buttons. */
function SkillRow({ row, shared }: { row: SkillManagerEntry; shared: RowShared }) {
  const { fileTrees, t, controller } = shared
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [confirmEnabled, setConfirmEnabled] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const resourcePath = row.resourcePath
  const tree = open && resourcePath !== undefined ? fileTrees[resourcePath] : undefined

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (next && resourcePath !== undefined && fileTrees[resourcePath] === undefined) {
      void controller.loadFileTree(resourcePath)
    }
  }

  const stop = (event: React.MouseEvent): void => event.stopPropagation()

  const runExport = async (): Promise<void> => {
    if (row.resourcePath === undefined) return
    const value = await controller.exportSkill(row.resourcePath)
    if ('error' in value) {
      setFeedback(t('exportFail', { message: value.error }))
      return
    }
    downloadBase64(value.zipBase64, value.fileName)
    setFeedback(null)
  }

  const startDelete = (): void => {
    setConfirming(true)
    setConfirmEnabled(false)
  }

  // Clear the activation timer on unmount so a stale activation never fires
  // setState on an unmounted component.
  useEffect(() => {
    if (!confirming) return
    const timer = window.setTimeout(() => setConfirmEnabled(true), 500)
    return () => window.clearTimeout(timer)
  }, [confirming])

  const runDelete = async (): Promise<void> => {
    if (row.resourcePath === undefined) return
    const ok = await controller.deleteSkill(row.resourcePath)
    if (typeof ok !== 'boolean') {
      setFeedback(t('deleteFail', { message: ok.error }))
      setConfirming(false)
      return
    }
    setConfirming(false)
    void shared.refreshAfterMutation()
  }

  const runDisable = async (): Promise<void> => {
    if (row.resourcePath === undefined) return
    const ok = await controller.toggleSkill(row.resourcePath, false)
    if (typeof ok !== 'boolean') {
      setFeedback(t('disableFail', { message: ok.error }))
      return
    }
    void shared.refreshAfterMutation()
  }

  const runEnable = async (): Promise<void> => {
    if (row.restorePath === undefined) return
    const ok = await controller.toggleSkill(row.restorePath, true)
    if (typeof ok !== 'boolean') {
      setFeedback(t('enableFail', { message: ok.error }))
      return
    }
    void shared.refreshAfterMutation()
  }

  const disabled = row.disabled === true

  return (
    <li className={styles.skillRow} data-tier={row.tier} data-disabled={disabled || undefined}>
      <div className={styles.skillHeader} onClick={toggle}>
        <button type="button" className={styles.skillToggle} aria-expanded={open} onClick={event => { event.stopPropagation(); toggle() }}>
          {row.resourcePath !== undefined
            ? (open ? <IconChevronDownOutlineRegular size={14} /> : <IconChevronRightOutlineRegular size={14} />)
            : <span className={styles.skillChevronSpacer} />}
        </button>
        <span className={styles.skillName}>{row.name}</span>
        <span className={styles.skillDescription}>{row.description}</span>
        <span className={styles.rowMeta}>
          {row.readOnly && <span className={styles.badge} data-badge="readonly">{t('readOnly')}</span>}
          {disabled && <span className={styles.badge} data-badge="disabled">{t('disabledTier')}</span>}
          {!row.modelInvocable && <span className={styles.badge}>{t('userOnly')}</span>}
        </span>
        {row.resourcePath !== undefined && (
          <span className={styles.rowActions} onClick={stop}>
            {!disabled && (
              <button type="button" className={styles.actionButton} title={t('exportAria')} onClick={() => { void runExport() }}>
                {t('export')}
              </button>
            )}
            {!row.readOnly && (
              disabled ? (
                <button type="button" className={styles.actionButton} title={t('enable')} onClick={() => { void runEnable() }}>
                  {t('enable')}
                </button>
              ) : (
                <>
                  <button type="button" className={styles.actionButton} title={t('disable')} onClick={() => { void runDisable() }}>
                    {t('disable')}
                  </button>
                  {!confirming ? (
                    <button type="button" className={styles.actionButton} title={t('delete')} onClick={startDelete}>
                      {t('delete')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={`${styles.actionButton} ${styles.deleteConfirm}`}
                      disabled={!confirmEnabled}
                      onClick={() => { if (confirmEnabled) void runDelete() }}
                    >
                      {t('deleteConfirm')}
                    </button>
                  )}
                </>
              )
            )}
          </span>
        )}
      </div>
      {feedback !== null && <p className={styles.rowFeedback}>{feedback}</p>}
      {open && row.resourcePath !== undefined && (
        <div className={styles.fileTree}>
          {tree === 'loading' && <p className={styles.notice}>{t('loading')}</p>}
          {tree !== undefined && tree !== 'loading' && (
            <FileNode node={tree} shared={shared} writable={!row.readOnly} depth={0} />
          )}
          {tree === undefined && <p className={styles.notice}>{t('emptyTree')}</p>}
        </div>
      )}
    </li>
  )
}

/** Trigger a browser download from base64 bytes. */
function downloadBase64(base64: string, fileName: string): void {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/** One recursive file-tree node. */
function FileNode({ node, shared, writable, depth }: {
  node: SkillManagerFileNode
  shared: RowShared
  writable: boolean
  depth: number
}) {
  const { t, controller } = shared
  const [open, setOpen] = useState(false)
  if (node.kind === 'directory') {
    return (
      <div className={styles.fileNode}>
        <button type="button" className={styles.fileRow} style={{ paddingLeft: `${8 + depth * 14}px` }} onClick={() => setOpen(v => !v)}>
          {open ? <IconChevronDownOutlineRegular size={12} /> : <IconChevronRightOutlineRegular size={12} />}
          <IconFolderOpenOutlineRegular size={14} />
          <span className={styles.fileName}>{node.name}</span>
        </button>
        {open && node.children !== undefined && node.children.map(child => (
          <FileNode key={child.path} node={child} shared={shared} writable={writable} depth={depth + 1} />
        ))}
      </div>
    )
  }
  return (
    <div className={styles.fileNode}>
      <button type="button" className={styles.fileRow} style={{ paddingLeft: `${8 + depth * 14}px` }} onClick={() => controller.openFile(node.path, node.name, writable)}>
        <span className={styles.fileIconSpacer} />
        <IconCodeOutlineRegular size={14} />
        <span className={styles.fileName}>{node.name}</span>
        {node.size !== undefined && <span className={styles.fileSize}>{String(node.size)} B</span>}
      </button>
    </div>
  )
}

/** One workspace collapsible group of project skills. */
function WorkspaceGroup({ group, shared }: { group: WorkspaceSkillGroup; shared: RowShared }) {
  const { t, controller } = shared
  const [expanded, setOpen] = useState(true)
  const open = shared.searching || expanded
  return (
    <section className={styles.workspaceGroup}>
      <div className={styles.workspaceHeaderRow}>
        <button type="button" className={styles.workspaceHeader} onClick={() => setOpen(v => !v)} aria-expanded={open}>
          {open ? <IconChevronDownOutlineRegular size={14} /> : <IconChevronRightOutlineRegular size={14} />}
          <IconFolderOpenOutlineRegular size={14} />
          <span className={styles.workspaceTitle}>{group.title}</span>
          <span className={styles.tierCount}>{t('count', { count: String(group.skills.length) })}</span>
        </button>
        <span className={styles.tierExtra} onClick={event => event.stopPropagation()}>
          <ImportButton
            tier="workspace"
            workspacePath={group.path}
            controller={controller}
            t={t}
            onDone={() => { shared.refreshAfterMutation() }}
            onError={message => { void shared.reportError(t('importFail', { message })) }}
          />
        </span>
      </div>
      {open && (
        <ul className={styles.rows}>
          {group.skills.map(row => <SkillRow key={row.name} row={row} shared={shared} />)}
        </ul>
      )}
    </section>
  )
}

/** One preset collapsible group of preset-provided skills. */
function PresetGroup({ group, shared }: { group: PresetSkillGroup; shared: RowShared }) {
  const { t } = shared
  const [expanded, setOpen] = useState(true)
  const open = shared.searching || expanded
  return (
    <section className={styles.workspaceGroup}>
      <button type="button" className={styles.workspaceHeader} onClick={() => setOpen(v => !v)} aria-expanded={open}>
        {open ? <IconChevronDownOutlineRegular size={14} /> : <IconChevronRightOutlineRegular size={14} />}
        <IconFolderOpenOutlineRegular size={14} />
        <span className={styles.workspaceTitle}>{window.__DSH_SKILL_MANAGER_OPTIONS__?.presetGroupLabels?.find(rule => group.id.startsWith(rule.prefix))?.label ?? group.id}</span>
        <span className={styles.tierCount}>{t('count', { count: String(group.skills.length) })}</span>
      </button>
      {open && (
        <ul className={styles.rows}>
          {group.skills.map(row => <SkillRow key={`${group.id}:${row.name}`} row={row} shared={shared} />)}
        </ul>
      )}
    </section>
  )
}

/** One plugin-provider collapsible group of bundled plugin skills. */
function PluginGroup({ group, shared }: { group: PluginSkillGroup; shared: RowShared }) {
  const { t } = shared
  const [expanded, setOpen] = useState(true)
  const open = shared.searching || expanded
  return (
    <section className={styles.workspaceGroup}>
      <button type="button" className={styles.workspaceHeader} onClick={() => setOpen(v => !v)} aria-expanded={open}>
        {open ? <IconChevronDownOutlineRegular size={14} /> : <IconChevronRightOutlineRegular size={14} />}
        <IconFolderOpenOutlineRegular size={14} />
        <span className={styles.workspaceTitle}>{group.provider}</span>
        <span className={styles.tierCount}>{t('count', { count: String(group.skills.length) })}</span>
      </button>
      {open && (
        <ul className={styles.rows}>
          {group.skills.map(row => <SkillRow key={`${group.provider}:${row.name}`} row={row} shared={shared} />)}
        </ul>
      )}
    </section>
  )
}

/** One collapsible top-level tier (system / user / preset / project), closed by default. */
function TierSection({ title, hint, info, count, t, extra, searching, children }: {
  title: string
  hint: string
  info?: string
  count: number
  t: SkillManagerInjected['t']
  extra?: React.ReactNode
  searching: boolean
  children: React.ReactNode
}) {
  const [expanded, setOpen] = useState(false)
  const open = searching || expanded
  return (
    <section className={styles.tier}>
      <div className={styles.tierHeaderRow}>
        <button type="button" className={styles.tierHeader} onClick={() => setOpen(v => !v)} aria-expanded={open}>
          {open ? <IconChevronDownOutlineRegular size={14} /> : <IconChevronRightOutlineRegular size={14} />}
          <h3 className={styles.tierTitle}>{title}</h3>
          <span className={styles.tierHint}>{hint}</span>
          <span className={styles.tierCount}>{t('count', { count: String(count) })}</span>
        </button>
        {info !== undefined && (
          <span className={styles.tierInfo} role="tooltip" aria-label={info} onClick={event => event.stopPropagation()}>
            <IconQuestionOutlineRegular size={14} />
            <span className={styles.tierInfoBubble}>{info}</span>
          </span>
        )}
        {extra !== undefined && <span className={styles.tierExtra} onClick={event => event.stopPropagation()}>{extra}</span>}
      </div>
      {open && children}
    </section>
  )
}

/** Import button: hidden file input reading a zip, then importing into a tier. */
function ImportButton({ tier, workspacePath, controller, t, onDone, onError }: {
  tier: 'user' | 'workspace'
  workspacePath?: string
  controller: SkillManagerController
  t: SkillManagerInjected['t']
  onDone: () => void
  onError: (message: string) => void
}) {
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const pick = (): void => { inputRef.current?.click() }
  const onFile = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    setBusy(true)
    try {
      const base64 = await fileToBase64(file)
      const imported = await controller.importSkill(base64, tier, workspacePath)
      if ('error' in imported) {
        onError(imported.error)
      } else {
        onDone()
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : 'endpoint failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button type="button" className={styles.actionButton} title={t('importAria')} onClick={pick} disabled={busy}>
        {busy ? t('importBusy') : t('import')}
      </button>
      <input ref={inputRef} type="file" accept=".zip,application/zip" style={{ display: 'none' }} onChange={(e) => { void onFile(e) }} />
    </>
  )
}

/** Read a File as base64. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      resolve(typeof result === 'string' ? result.split(',')[1] ?? '' : '')
    }
    reader.onerror = () => reject(new Error('file read failed'))
    reader.readAsDataURL(file)
  })
}

/**
 * Render the Skill Manager panel.
 * @param props - inject face (spread flat by the outlet).
 * @returns the page element tree.
 */
export function SkillManagerPanel({ usePanel, refresh, refreshSilent, t, controller }: SkillManagerPanelProps) {
  if (usePanel === undefined || refresh === undefined || t === undefined || controller === undefined) return null
  const state = usePanel(s => s)
  // After a delete/import the data changed but the user's expand/collapse
  // layout must survive: a silent refresh swaps the rows without toggling
  // the loading flag (which would unmount and remount every collapsible).
  const refreshAfterMutation = (): void => {
    if (refreshSilent !== undefined) refreshSilent()
    else refresh()
  }
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  const searching = query.length > 0
  const matches = ({ name, description, provider }: SkillManagerEntry): boolean =>
    !searching || [name, description, provider].some(part => part.toLowerCase().includes(query))
  const shared: RowShared = {
    fileTrees: state.fileTrees,
    refreshAfterMutation,
    reportError: (message: string) => setError(message),
    searching,
    t,
    controller,
  }

  // Refresh when the Skills tab mounts.
  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sectionRules = window.__DSH_SKILL_MANAGER_OPTIONS__?.sections ?? []
  const sectionBuckets = sectionRules.map(rule => ({ rule, skills: new Map<string, SkillManagerEntry>() }))
  const findSection = (id: string) => sectionBuckets.find(({ rule }) => rule.matchPrefixes.some(prefix => id.startsWith(prefix)))
  const addSkill = (section: (typeof sectionBuckets)[number], row: SkillManagerEntry): void => {
    const key = `${row.provider}:${row.name}`
    if (!section.skills.has(key)) section.skills.set(key, row)
  }
  const remainingPresetGroups: PresetSkillGroup[] = []
  for (const group of state.presetGroups) {
    const presetSection = findSection(group.id)
    const remainingSkills: SkillManagerEntry[] = []
    for (const row of group.skills) {
      if (!matches(row)) continue
      const section = findSection(row.provider) ?? presetSection
      if (section === undefined) remainingSkills.push(row)
      else addSkill(section, row)
    }
    if (remainingSkills.length > 0) remainingPresetGroups.push({ ...group, skills: remainingSkills })
  }
  const remainingPluginGroups: PluginSkillGroup[] = []
  for (const group of state.pluginGroups) {
    const skills = group.skills.filter(matches)
    if (skills.length === 0) continue
    const section = findSection(group.provider)
    if (section === undefined) remainingPluginGroups.push({ ...group, skills })
    else for (const row of skills) addSkill(section, row)
  }
  const systemSkills = state.byTier.system.filter(matches)
  const userSkills = state.byTier.user.filter(matches)
  const projectGroups = searching
    ? state.projectGroups.map(group => ({ ...group, skills: group.skills.filter(matches) })).filter(group => group.skills.length > 0)
    : state.projectGroups
  const visibleSections = searching ? sectionBuckets.filter(section => section.skills.size > 0) : sectionBuckets
  const noMatches = searching && state.error === null && [
    systemSkills, userSkills, projectGroups, remainingPresetGroups, remainingPluginGroups, visibleSections,
  ].every(group => group.length === 0)

  const renderRows = (skills: SkillManagerEntry[]) => (
    <ul className={styles.rows}>
      {skills.map(row => <SkillRow key={`${row.provider}:${row.name}`} row={row} shared={shared} />)}
    </ul>
  )

  return (
    <div className={styles.page} data-skill-manager-page>
      <header className={styles.header}>
        <div className={styles.headerActions}>
          <Input
            className={styles.search}
            icon={<IconSearchOutlineRegular size={14} />}
            aria-label={t('search')}
            placeholder={t('search')}
            value={search}
            onChange={event => setSearch(event.currentTarget.value)}
          />
          <button type="button" className={styles.iconButton} aria-label={t('refresh')} onClick={refresh}>
            <IconRefreshOutlineRegular size={14} />
          </button>
        </div>
      </header>
      {error !== null && <p className={styles.error} data-skill-error>{error}</p>}
      {state.loading
        ? <p className={styles.notice}>{t('loading')}</p>
        : (
          <>
            {state.error !== null && <p className={styles.error}>{t('error', { message: state.error })}</p>}
            {!state.complete && <p className={styles.notice}>{t('incomplete')}</p>}
            {noMatches && <p className={styles.notice}>{t('noMatches')}</p>}
            <div className={styles.tiers}>
              {systemSkills.length > 0 && (
                <TierSection title={t('tierSystem')} hint={t('tierSystemHint')} info={t('tierSystemInfo')} count={systemSkills.length} searching={searching} t={t}>
                  {renderRows(systemSkills)}
                </TierSection>
              )}
              {(!searching || userSkills.length > 0) && (
                <TierSection
                  title={t('tierUser')}
                  hint={t('tierUserHint')}
                  info={t('tierUserInfo')}
                  count={userSkills.length}
                  searching={searching}
                  t={t}
                  extra={<ImportButton
                    tier="user"
                    controller={controller}
                    t={t}
                    onDone={refreshAfterMutation}
                    onError={message => setError(t('importFail', { message }))}
                  />}
                >
                  {renderRows(userSkills)}
                  {userSkills.length === 0 && <p className={styles.empty}>{t('empty')}</p>}
                </TierSection>
              )}

              {visibleSections.map(({ rule, skills }) => (
                <TierSection
                  key={rule.id}
                  title={rule.title}
                  hint={rule.hint ?? ''}
                  info={rule.info}
                  count={skills.size}
                  searching={searching}
                  t={t}
                >
                  <ul className={styles.rows}>
                    {Array.from(skills, ([key, row]) => <SkillRow key={key} row={row} shared={shared} />)}
                  </ul>
                  {skills.size === 0 && <p className={styles.empty}>{t('empty')}</p>}
                </TierSection>
              ))}

              {remainingPluginGroups.length > 0 && (
                <TierSection
                  title={t('tierPlugin')}
                  hint={t('tierPluginHint')}
                  info={t('tierPluginInfo')}
                  count={remainingPluginGroups.reduce((n, g) => n + g.skills.length, 0)}
                  searching={searching}
                  t={t}
                >
                  <div className={styles.workspaces}>
                    {remainingPluginGroups.map(group => <PluginGroup key={group.provider} group={group} shared={shared} />)}
                  </div>
                </TierSection>
              )}

              {remainingPresetGroups.length > 0 && (
                <TierSection
                  title={t('tierCustom')}
                  hint={t('tierCustomHint')}
                  info={t('tierCustomInfo')}
                  count={remainingPresetGroups.reduce((n, g) => n + g.skills.length, 0)}
                  searching={searching}
                  t={t}
                >
                  <div className={styles.workspaces}>
                    {remainingPresetGroups.map(group => <PresetGroup key={group.id} group={group} shared={shared} />)}
                  </div>
                </TierSection>
              )}

              {(!searching || projectGroups.length > 0) && (
                <TierSection
                  title={t('tierProject')}
                  hint={t('tierProjectHint')}
                  info={t('tierProjectInfo')}
                  count={projectGroups.reduce((n, g) => n + g.skills.length, 0)}
                  searching={searching}
                  t={t}
                >
                  <div className={styles.workspaces}>
                    {projectGroups.map(group => <WorkspaceGroup key={group.id ?? group.title} group={group} shared={shared} />)}
                  </div>
                  {projectGroups.length === 0 && <p className={styles.empty}>{t('empty')}</p>}
                </TierSection>
              )}
            </div>
          </>
        )}
      <SkillManagerEditor usePanel={usePanel} controller={controller} t={t} />
    </div>
  )
}
