import { useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { Button, Checkbox, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  AGENT_PLUGIN_DISCOVERY_SOURCES, AGENT_PLUGIN_ZIP_LIMIT,
  type AgentPluginCandidate, type AgentPluginCommitInput, type AgentPluginDiscoverySource, type AgentPluginPreview,
} from '../agent-plugin-import-contract.ts'
import type { LocaleKey } from './locales.ts'
import styles from './mcp-manager-section.module.css'

export interface AgentPluginView {
  id: string
  name: string
  description: { zh: string; en: string }
  icon?: string
  enabled: boolean
  imported: boolean
  skills: { name: string; description: string }[]
  connectorIds: string[]
}

const exportTargets = {
  standard: 'Agent Plugins 1.0.0',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
}

export type AgentPluginExportFormat = keyof typeof exportTargets

interface AgentPluginExportProps {
  t: (key: LocaleKey) => string
  busy: boolean
  onExport: (format: AgentPluginExportFormat) => Promise<boolean>
}

export function AgentPluginExport({ t, busy, onExport }: AgentPluginExportProps) {
  const [format, setFormat] = useState<AgentPluginExportFormat | null>(null)
  if (format === null) {
    return (
      <Button variant="outline" size="sm" disabled={busy} onClick={() => setFormat('standard')}>
        {t('agentPluginExport')}
      </Button>
    )
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!busy && await onExport(format)) setFormat(null)
  }
  return (
    <form className={styles.detailActions} onSubmit={event => void submit(event)}>
      <select
        className={styles.select}
        aria-label={t('agentPluginExportFormat')}
        disabled={busy}
        value={format}
        onChange={event => setFormat(event.currentTarget.value as AgentPluginExportFormat)}
      >
        {Object.entries(exportTargets).map(([target, label]) => <option key={target} value={target}>{label}</option>)}
      </select>
      <Button type="submit" variant="primary" size="sm" disabled={busy}>
        {t(busy ? 'agentPluginExporting' : 'agentPluginExportDownload')}
      </Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setFormat(null)}>{t('cancel')}</Button>
    </form>
  )
}

export type AgentPluginPreviewInput = { directory: string } | { file: File } | { source: AgentPluginDiscoverySource; candidate: string }

interface AgentPluginImportProps {
  t: (key: LocaleKey) => string
  busy: boolean
  pickDirectory?: () => Promise<string | null>
  onPreview: (input: AgentPluginPreviewInput) => Promise<AgentPluginPreview>
  onDiscover: (source: AgentPluginDiscoverySource) => Promise<AgentPluginCandidate[]>
  onImport: (input: AgentPluginCommitInput) => Promise<void>
  onDiscard: (id: string) => void
  onClose: () => void
}

function toggleItem(items: string[], id: string): string[] {
  return items.includes(id) ? items.filter(item => item !== id) : [...items, id]
}

export function AgentPluginStdioConfirmation({ commands, checked, disabled, onChange, t }: {
  commands: AgentPluginPreview['servers']
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
  t: (key: LocaleKey) => string
}) {
  return (
    <fieldset className={styles.importGroup} disabled={disabled}>
      <legend>{t('agentPluginStdioCommands')}</legend>
      <ul className={styles.importCommands}>
        {commands.map(server => (
          <li key={server.id}>
            <span>{server.id}</span>
            <code>{JSON.stringify([server.command, ...(server.args ?? [])])}</code>
          </li>
        ))}
      </ul>
      <Checkbox
        label={t('agentPluginStdioConfirm')}
        className={styles.importChoice}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
    </fieldset>
  )
}

export function AgentPluginImport({ t, busy, pickDirectory, onPreview, onDiscover, onImport, onDiscard, onClose }: AgentPluginImportProps) {
  const [directory, setDirectory] = useState('')
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)
  const [discovered, setDiscovered] = useState<{ source: AgentPluginDiscoverySource; candidates: AgentPluginCandidate[] }>()
  const [preview, setPreview] = useState<AgentPluginPreview>()
  const [serverIds, setServerIds] = useState<string[]>([])
  const [skillNames, setSkillNames] = useState<string[]>([])
  const [allowStdio, setAllowStdio] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const locked = busy || pending
  const commands = preview?.servers.filter(server => server.command && serverIds.includes(server.id)) ?? []

  const run = async (action: () => Promise<void>, fallback: LocaleKey) => {
    if (locked) return
    setPending(true)
    setError(undefined)
    try {
      await action()
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : t(fallback))
    } finally {
      setPending(false)
    }
  }

  const showPreview = async (input: AgentPluginPreviewInput) => {
    const next = await onPreview(input)
    setPreview(next)
    setServerIds(next.servers.map(server => server.id))
    setSkillNames(next.skills.map(skill => skill.name))
    setAllowStdio(false)
  }

  const discardPreview = () => {
    if (preview) onDiscard(preview.id)
    setPreview(undefined)
    setError(undefined)
  }

  const close = () => {
    discardPreview()
    onClose()
  }

  const choose = () => run(async () => {
    const selected = await pickDirectory?.()
    if (selected) await showPreview({ directory: selected })
  }, 'agentPluginBrowseFailed')

  const selectFile = (event: ChangeEvent<HTMLInputElement>) => {
    const [file] = event.currentTarget.files ?? []
    event.currentTarget.value = ''
    if (!file || locked) return
    if (!file.name.toLowerCase().endsWith('.zip') || file.size > AGENT_PLUGIN_ZIP_LIMIT) {
      setError(t('agentPluginZipInvalid'))
      return
    }
    void run(() => showPreview({ file }), 'agentPluginPreviewFailed')
  }

  const discover = (source: AgentPluginDiscoverySource) => run(async () => {
    setDiscovered(undefined)
    setDiscovered({ source, candidates: await onDiscover(source) })
  }, 'agentPluginPreviewFailed')

  if (preview) {
    const selectable = preview.format === 'codex'
    const nothingSelected = selectable && (preview.servers.length > 0 || preview.skills.length > 0) && !serverIds.length && !skillNames.length
    const submit = async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if ((commands.length > 0 && !allowStdio) || nothingSelected) return
      await run(async () => {
        await onImport({ id: preview.id, serverIds, skillNames, allowStdio: commands.length > 0 && allowStdio })
        onClose()
      }, 'agentPluginImportFailed')
    }
    return (
      <form className={styles.customForm} onSubmit={event => void submit(event)} aria-busy={locked}>
        <h3 className={styles.panelTitle}>{preview.name}</h3>
        <p className={styles.hint}>{exportTargets[preview.format]}</p>
        <div className={styles.importItems}>
          <fieldset className={styles.importGroup} disabled={locked}>
            <legend>{t('agentPluginImportMcp').replace('{n}', String(preview.servers.length))}</legend>
            {preview.servers.map(server => selectable ? (
              <Checkbox
                key={server.id}
                label={server.id}
                className={styles.importChoice}
                checked={serverIds.includes(server.id)}
                disabled={locked}
                onChange={() => {
                  setServerIds(ids => toggleItem(ids, server.id))
                  setAllowStdio(false)
                }}
              />
            ) : <span key={server.id} className={styles.importChoice}>{server.id}</span>)}
          </fieldset>
          <fieldset className={styles.importGroup} disabled={locked}>
            <legend>{t('agentPluginSkills').replace('{n}', String(preview.skills.length))}</legend>
            {preview.skills.map(skill => selectable ? (
              <Checkbox
                key={skill.name}
                label={skill.name}
                className={styles.importChoice}
                checked={skillNames.includes(skill.name)}
                disabled={locked}
                onChange={() => setSkillNames(names => toggleItem(names, skill.name))}
              />
            ) : <span key={skill.name} className={styles.importChoice}>{skill.name}</span>)}
          </fieldset>
        </div>
        {!!preview.warnings?.length && (
          <ul className={styles.importWarnings}>
            {preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
          </ul>
        )}
        {commands.length > 0 && (
          <AgentPluginStdioConfirmation commands={commands} checked={allowStdio} disabled={locked} onChange={setAllowStdio} t={t} />
        )}
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <div className={styles.noticeActions}>
          <Button type="submit" variant="primary" size="sm" disabled={locked || nothingSelected || (commands.length > 0 && !allowStdio)}>
            {t(pending ? 'agentPluginImporting' : 'agentPluginImportConfirm')}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={locked} onClick={discardPreview}>{t('agentPluginImportBack')}</Button>
          <Button type="button" variant="ghost" size="sm" disabled={locked} onClick={close}>{t('cancel')}</Button>
        </div>
      </form>
    )
  }

  const submitPath = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (directory.trim()) void run(() => showPreview({ directory: directory.trim() }), 'agentPluginPreviewFailed')
  }
  return (
    <form className={styles.customForm} onSubmit={submitPath} aria-busy={locked}>
      <div className={styles.noticeActions}>
        {pickDirectory && (
          <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => void choose()}>
            {t('agentPluginBrowse')}
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => fileInput.current?.click()}>
          {t('agentPluginZip')}
        </Button>
        <input ref={fileInput} type="file" accept=".zip,application/zip" onChange={selectFile} hidden />
        <select
          className={styles.select}
          aria-label={t('agentPluginDiscover')}
          disabled={locked}
          value=""
          onChange={event => {
            const source = AGENT_PLUGIN_DISCOVERY_SOURCES.find(item => item === event.currentTarget.value)
            if (source) void discover(source)
          }}
        >
          <option value="" disabled>{t('agentPluginDiscover')}</option>
          {AGENT_PLUGIN_DISCOVERY_SOURCES.map(source => <option key={source} value={source}>{exportTargets[source]}</option>)}
        </select>
      </div>
      <label className={styles.field}>
        <span>{t('agentPluginDirectory')}</span>
        <Input value={directory} disabled={locked} onChange={event => setDirectory(event.currentTarget.value)} />
      </label>
      {discovered && (
        <div className={styles.importGroup}>
          <b>{exportTargets[discovered.source]}</b>
          {discovered.candidates.length === 0
            ? <p className={styles.hint}>{t('agentPluginDiscoveryEmpty')}</p>
            : discovered.candidates.map(candidate => (
              <Button
                key={candidate.id}
                type="button"
                variant="ghost"
                size="sm"
                disabled={locked}
                onClick={() => void run(() => showPreview({ source: discovered.source, candidate: candidate.id }), 'agentPluginPreviewFailed')}
              >
                {candidate.name}
              </Button>
            ))}
        </div>
      )}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <div className={styles.noticeActions}>
        <Button type="submit" variant="primary" size="sm" disabled={locked || !directory.trim()}>
          {t(pending ? 'agentPluginPreviewLoading' : 'agentPluginPreview')}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={locked} onClick={close}>{t('cancel')}</Button>
      </div>
    </form>
  )
}
