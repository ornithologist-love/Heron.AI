/**
 * dsh-mcp-manager — browser half.
 *
 * Presents registered connectors on the Connectors page with a unified 4-state model,
 * equal-height overview cards, an in-page detail view, and custom MCP server
 * management.
 *
 * @module dsh-mcp-manager/client
 */

import { Fragment, useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import {
  Button,
  IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular,
  IconFolderOpenOutlineRegular,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  IconSearchOutlineRegular,
  Input,
  SegmentedTabs,
  StateDot,
  Switch,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { AgentPluginCandidate, AgentPluginCommitInput, AgentPluginDiscoverySource, AgentPluginPreview } from '../agent-plugin-import-contract.ts'
import {
  AgentPluginExport, AgentPluginImport, type AgentPluginExportFormat, type AgentPluginPreviewInput, type AgentPluginView,
} from './agent-plugins.tsx'
import { en, fmt, zh, type LocaleKey } from './locales.ts'
import { reconnectWithOAuth } from './reconnect.ts'
import { ConnectorCard, connectorGrid, type ConnectorCardProps } from './connector-card.tsx'
import { ConnectorsPanelIcon } from './ConnectorsPanelIcon.tsx'
import { connectorOverview, deriveConnectorState, filterCustomServers, type ConnectorTab, type ConnectorTone } from './state.ts'
import styles from './mcp-manager-section.module.css'

interface ConnectorBrand {
  title: string
  description: { zh: string; en: string }
  icon?: string
}

export interface McpServerView {
  serverName: string
  agentPluginId?: string
  connectorPresentation: ConnectorBrand & { id?: string; group?: ConnectorBrand & { id: string } }
  authorized?: boolean
  toolNames?: string[]
  enabled?: boolean
  status?: string
  error?: string
  authType?: 'none' | 'oauth'
}

export interface CustomMcpServer {
  serverName: string
  transport: 'stdio' | 'streamable-http'
  url?: string
  command?: string
  args?: string[]
  cwd?: string
  enabled?: boolean
  status?: string
  error?: string
  authType?: 'none' | 'oauth'
  authorized?: boolean
  toolNames?: string[]
  connectorPresentation?: unknown
}

export interface ConnectorDetailService {
  id: string
  name: string
  meta?: string
  actions?: ReactNode
}

export interface ConnectorDetailTool {
  name: string
  description?: string
  tag?: string
}

export interface ConnectorDetailProps {
  id: string
  name: string
  icon?: string
  description: string
  status: string
  tone: ConnectorTone
  actions?: ReactNode
  notice?: ReactNode
  services?: ConnectorDetailService[]
  servicesTitle?: string
  tools?: ConnectorDetailTool[]
  maintenance?: ReactNode
  extra?: ReactNode
}

export interface McpManagerSectionInjected {
  list: () => Promise<McpServerView[]>
  listAll?: () => Promise<CustomMcpServer[]>
  listAgentPlugins?: () => Promise<{ plugins: AgentPluginView[]; canManage: boolean }>
  pickPluginDirectory?: () => Promise<string | null>
  setEnabled: (serverName: string, enabled: boolean) => Promise<void>
  reconnect: (serverName: string) => Promise<void>
  skillsSlot: { subscribe(listener: () => void): () => void; getSnapshot(): boolean }
}

export interface ConnectorSlotProps {
  activeDetailId: string | null
  openDetail: (id: string) => void
  closeDetail: () => void
  renderConnector: (card: ConnectorCardProps) => ReactNode
  renderDetail: (detail: ConnectorDetailProps) => ReactNode
}

export interface McpManagerSectionProps extends McpManagerSectionInjected {
  /** Bound to the `mcpManager` locale namespace by the main slot. */
  t: (key: LocaleKey) => string
  language?: () => 'zh' | 'en'
  renderSlot?: {
    (name: 'settings.connectors.card', props: ConnectorSlotProps): ReactNode
    (name: 'connectors.skills', props: Record<never, never>): ReactNode
  }
  renderFactorySlot?: (name: 'connectors.cards', props: ConnectorSlotProps) => ReactNode
  // The slot runtime may bind additional props.
  [key: string]: unknown
}

/** Locale namespace owned by this plugin. */
export const NS = 'mcpManager'

const API = '/mcp-manager/api'
const POLL_INTERVAL_MS = 800
const DEFAULT_WAIT_SECONDS = 15
const TOKEN_STORAGE_KEY = 'mcpManager.accessToken'
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/

const agentPluginDetailId = (id: string) => `agent-plugin:${id}`

const dotStates: Record<ConnectorTone, 'done' | 'ongoing' | 'error' | 'idle'> = {
  connected: 'done',
  connecting: 'ongoing',
  error: 'error',
  disconnected: 'idle',
}

function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const accessToken = window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? ''
  if (accessToken !== '') headers.set('Authorization', `Bearer ${accessToken}`)
  return fetch(url, { ...init, headers })
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  let body: { ok: boolean; error?: string } & T
  try {
    body = await response.json() as typeof body
  } catch {
    throw new Error(`MCP manager: invalid response (${response.status})`)
  }
  if (!response.ok || body.ok === false) {
    throw new Error(body.error ?? `request failed (${response.status})`)
  }
  return body
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  return readJsonResponse<T>(await apiFetch(url, init))
}

function discardAgentPlugin(id: string): void {
  void request(`${API}/agent-plugins/discard`, { method: 'POST', body: JSON.stringify({ id }) }).catch(() => undefined)
}

async function pollServer<T extends { serverName: string; status?: string }>(
  fetchList: () => Promise<T[]>,
  serverName: string,
) {
  const deadline = Date.now() + DEFAULT_WAIT_SECONDS * 1000
  for (;;) {
    const items = await fetchList()
    if (!items.some(server => server.serverName === serverName && server.status === 'connecting')) {
      return { items, timedOut: false }
    }
    if (Date.now() >= deadline) return { items, timedOut: true }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

export function McpManagerSection({
  list, listAll, listAgentPlugins, pickPluginDirectory, setEnabled, reconnect, skillsSlot, t, language, renderSlot, renderFactorySlot,
}: McpManagerSectionProps) {
  const [servers, setServers] = useState<McpServerView[]>([])
  const [customServers, setCustomServers] = useState<CustomMcpServer[]>([])
  const [agentPlugins, setAgentPlugins] = useState<AgentPluginView[]>([])
  const [canManageAgentPlugins, setCanManageAgentPlugins] = useState(false)
  const [showPluginImport, setShowPluginImport] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [requestedTab, setRequestedTab] = useState<ConnectorTab>('connectors')
  const tabsId = useId()
  const hasSkills = useSyncExternalStore(skillsSlot.subscribe, skillsSlot.getSnapshot)
  const { showTabs, activeTab } = connectorOverview(requestedTab, hasSkills, selectedId)
  const [toolFilter, setToolFilter] = useState('')
  const [showAddForm, setShowAddForm] = useState(false)
  const [formError, setFormError] = useState<string>()
  const [newName, setNewName] = useState('')
  const [newTransport, setNewTransport] = useState<'streamable-http' | 'stdio'>('streamable-http')
  const [newUrl, setNewUrl] = useState('')
  const [newAuthType, setNewAuthType] = useState<'none' | 'oauth'>('none')
  const [newCommand, setNewCommand] = useState('')
  const [newArgs, setNewArgs] = useState('')
  const [newCwd, setNewCwd] = useState('')
  const [connectorLink, setConnectorLink] = useState<{ serverName: string; url: string; copy?: 'copied' | 'select' }>()
  const oauthCancellation = useRef<{ serverName: string; controller: AbortController } | null>(null)
  useEffect(() => () => oauthCancellation.current?.controller.abort(), [])

  const fetchAllServers = async (): Promise<CustomMcpServer[]> => {
    if (listAll) return listAll()
    const body = await request<{ servers: CustomMcpServer[] }>(`${API}/servers`)
    return body.servers
  }

  const refresh = async (): Promise<McpServerView[] | undefined> => {
    setLoading(true)
    setError(undefined)
    try {
      const [connectors, all, agentPluginList] = await Promise.all([
        list(), fetchAllServers(), listAgentPlugins?.(),
      ])
      setServers(connectors)
      setCustomServers(filterCustomServers(all))
      setAgentPlugins(agentPluginList?.plugins ?? [])
      setCanManageAgentPlugins(agentPluginList?.canManage === true)
      return connectors
    } catch {
      setError(t('loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [])
  useEffect(() => { setToolFilter('') }, [selectedId])

  const runWithPoll = async (busyKey: string, action: () => Promise<void>, signal?: AbortSignal): Promise<void> => {
    setBusy(busyKey)
    setError(undefined)
    try {
      await action()
      if (signal?.aborted) return
      const { items: settledAll, timedOut } = await pollServer(fetchAllServers, busyKey)
      setCustomServers(filterCustomServers(settledAll))
      setServers(await list())
      if (timedOut) {
        setError(fmt(t('timeoutMsg'), { n: DEFAULT_WAIT_SECONDS }))
      }
    } catch (err) {
      if (signal?.aborted) return
      await refresh()
      if (!signal?.aborted) {
        const message = err instanceof Error ? err.message : ''
        const authorizationError = ['oauthPopupBlocked', 'oauthHttpsRequired', 'oauthPopupClosed', 'oauthStillWaiting']
          .map(key => t(key as LocaleKey)).find(text => text === message)
        setError(authorizationError ?? t('error'))
      }
    } finally {
      if (!signal?.aborted) setBusy(current => current === busyKey ? undefined : current)
    }
  }

  const revokeOAuth = async (targetServerName: string): Promise<void> => {
    setBusy(targetServerName)
    setError(undefined)
    try {
      await request(`${API}/oauth/revoke`, {
        method: 'POST',
        body: JSON.stringify({ serverName: targetServerName }),
      })
      await refresh()
    } catch {
      setError(t('revokeFailed'))
    } finally {
      setBusy(undefined)
    }
  }

  const connectOrRetryServer = async (server: Pick<McpServerView, 'serverName' | 'enabled' | 'authType'>): Promise<void> => {
    const cancellation = new AbortController()
    oauthCancellation.current?.controller.abort()
    oauthCancellation.current = { serverName: server.serverName, controller: cancellation }
    setConnectorLink(undefined)
    const showLink = (url: string) => setConnectorLink({ serverName: server.serverName, url })
    try {
      const connect = server.enabled === false ? (id: string) => setEnabled(id, true) : reconnect
      await runWithPoll(
        server.serverName,
        () => reconnectWithOAuth(server as McpServerView, request, API, connect, t, cancellation.signal, showLink),
        cancellation.signal,
      )
    } finally {
      if (oauthCancellation.current?.controller === cancellation) {
        oauthCancellation.current = null
        setConnectorLink(link => link?.serverName === server.serverName ? undefined : link)
      }
    }
  }

  const cancelPendingServer = async (serverName: string): Promise<void> => {
    if (oauthCancellation.current?.serverName === serverName) {
      oauthCancellation.current.controller.abort()
      oauthCancellation.current = null
    }
    setConnectorLink(link => link?.serverName === serverName ? undefined : link)
    try {
      await setEnabled(serverName, false)
      await refresh()
    } catch {
      setError(t('toggleFailed'))
    } finally {
      setBusy(current => current === serverName ? undefined : current)
    }
  }

  const toggleEnabled = (serverName: string, nextEnabled: boolean): void => {
    void runWithPoll(serverName, async () => { await setEnabled(serverName, nextEnabled) })
  }

  const copyConnectorLink = async (link: NonNullable<typeof connectorLink>): Promise<void> => {
    let copy: 'copied' | 'select' = 'copied'
    try { await navigator.clipboard.writeText(link.url) } catch { copy = 'select' }
    setConnectorLink(current => current?.url === link.url ? { ...current, copy } : current)
  }

  const renderPrimaryAction = (
    server: Pick<McpServerView, 'serverName' | 'enabled' | 'authType' | 'status' | 'authorized' | 'error'>,
    label: string,
  ): ReactNode => {
    const link = connectorLink?.serverName === server.serverName ? connectorLink : undefined
    const derived = deriveConnectorState(server, busy === server.serverName, Boolean(link))
    const locked = busy !== undefined && busy !== server.serverName
    switch (derived.action) {
      case 'connect':
        return (
          <Button variant="primary" size="sm" disabled={locked} onClick={() => void connectOrRetryServer(server)}>
            {t('connectorConnect')}
          </Button>
        )
      case 'cancel':
        return (
          <Button variant="outline" size="sm" onClick={() => void cancelPendingServer(server.serverName)}>
            {t('cancel')}
          </Button>
        )
      case 'toggle':
        return (
          <Switch
            checked
            disabled={busy !== undefined}
            label={fmt(t('connectorToggle'), { name: label })}
            onChange={checked => toggleEnabled(server.serverName, checked)}
          />
        )
      case 'retry':
        return (
          <Button variant="outline" size="sm" disabled={locked} onClick={() => void connectOrRetryServer(server)}>
            {t('retry')}
          </Button>
        )
    }
  }

  const renderLinkNotice = (serverName: string, errorMessage?: string): ReactNode => {
    const link = connectorLink?.serverName === serverName ? connectorLink : undefined
    if (!link && !errorMessage) return undefined
    return (
      <div className={styles.noticeBanner}>
        {errorMessage && <p role="alert" className={styles.error}>{errorMessage}</p>}
        {link && (
          <>
            <span>{t('connectorWaiting')}</span>
            <div className={styles.noticeActions}>
              <Button variant="outline" size="sm" onClick={() => void copyConnectorLink(link)}>
                {t(link.copy === 'copied' ? 'oauthLinkCopied' : 'oauthCopyLink')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => void cancelPendingServer(serverName)}>
                {t('cancel')}
              </Button>
            </div>
            {link.copy === 'select' && (
              <Input value={link.url} readOnly aria-label={t('oauthCopyLink')} onFocus={e => e.currentTarget.select()} />
            )}
          </>
        )}
      </div>
    )
  }

  const previewAgentPlugin = async (input: AgentPluginPreviewInput): Promise<AgentPluginPreview> => {
    const options: RequestInit = 'file' in input
      ? { method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-Agent-Plugin-File': encodeURIComponent(input.file.name) }, body: input.file }
      : { method: 'POST', body: JSON.stringify(input) }
    const result = await request<{ preview: AgentPluginPreview }>(API + '/agent-plugins/preview', options)
    return result.preview
  }

  const discoverAgentPlugins = async (source: AgentPluginDiscoverySource): Promise<AgentPluginCandidate[]> => {
    const result = await request<{ candidates: AgentPluginCandidate[] }>(API + '/agent-plugins/preview', {
      method: 'POST', body: JSON.stringify({ source }),
    })
    return result.candidates
  }

  const importAgentPlugin = async (input: AgentPluginCommitInput): Promise<McpServerView[] | undefined> => {
    setBusy('agent-plugin:import')
    try {
      await request(API + '/agent-plugins/commit', { method: 'POST', body: JSON.stringify(input) })
      return await refresh()
    } finally {
      setBusy(undefined)
    }
  }

  const manageAgentPlugin = async (plugin: AgentPluginView, action: 'toggle' | 'remove'): Promise<void> => {
    setBusy(agentPluginDetailId(plugin.id))
    setError(undefined)
    try {
      const body = action === 'toggle' ? { id: plugin.id, enabled: !plugin.enabled } : { id: plugin.id }
      await request(`${API}/agent-plugins/${action}`, { method: 'POST', body: JSON.stringify(body) })
      if (action === 'remove') setSelectedId(null)
      await refresh()
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : t('agentPluginChangeFailed'))
    } finally {
      setBusy(undefined)
    }
  }

  const exportAgentPlugin = async (id: string, format: AgentPluginExportFormat): Promise<boolean> => {
    setBusy('agent-plugin:export')
    setError(undefined)
    try {
      const response = await apiFetch(API + '/agent-plugins/export', {
        method: 'POST',
        body: JSON.stringify({ id, format }),
      })
      if (!response.ok) await readJsonResponse(response)
      const fileName = response.headers.get('content-disposition')?.match(/^attachment; filename="([a-z0-9.-]+\.zip)"$/)?.[1]
      if (response.headers.get('content-type') !== 'application/zip' || !fileName) throw new Error(t('agentPluginExportFailed'))
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = fileName
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      return true
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : t('agentPluginExportFailed'))
      return false
    } finally {
      setBusy(undefined)
    }
  }

  const renderDetailShell = (detail: ConnectorDetailProps): ReactNode => {
    const localIcon = detail.icon && /^data:image\/(?:svg\+xml,|png;base64,)/.test(detail.icon) ? detail.icon : undefined
    const plugin = agentPlugins.find(item => item.connectorIds.includes(detail.id) || agentPluginDetailId(item.id) === detail.id)
    const tools = detail.tools ?? []
    const normalizedFilter = toolFilter.trim().toLowerCase()
    const visibleTools = normalizedFilter
      ? tools.filter(tool =>
        tool.name.toLowerCase().includes(normalizedFilter)
        || tool.description?.toLowerCase().includes(normalizedFilter)
        || tool.tag?.toLowerCase().includes(normalizedFilter))
      : tools

    return (
      <div className={styles.detailView} data-connector-detail={detail.id}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <Button
              variant="ghost"
              size="sm"
              icon={<IconChevronLeftOutlineRegular size={16} />}
              onClick={() => setSelectedId(null)}
            >
              {t('backToConnectors')}
            </Button>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className={styles.iconButton}
            icon={<IconRefreshOutlineRegular size={16} />}
            aria-label={t('refresh')}
            title={t('refresh')}
            disabled={loading}
            onClick={() => void refresh()}
          />
        </div>

        <header className={styles.detailHeader}>
          <div className={styles.detailIdentity}>
            <span className={styles.detailIcon} data-branded={localIcon ? '' : undefined} aria-hidden="true">
              {localIcon ? <img src={localIcon} alt="" width={26} height={26} /> : <ConnectorsPanelIcon size={22} />}
            </span>
            <div className={styles.detailMeta}>
              <h2 className={styles.detailTitle}>{detail.name}</h2>
              {detail.description && <p className={styles.detailDesc}>{detail.description}</p>}
              <span className={styles.detailStatus} role="status">
                <StateDot state={dotStates[detail.tone]} size={8} />
                <span>{detail.status}</span>
              </span>
            </div>
          </div>
          {detail.actions && <div className={styles.detailActions}>{detail.actions}</div>}
        </header>

        {error !== undefined && <p role="alert" className={styles.error}>{error}</p>}
        {detail.notice}

        {detail.services && detail.services.length > 0 && (
          <section className={styles.detailPanel}>
            <div className={styles.panelHeader}>
              <h3 className={styles.panelTitle}>{detail.servicesTitle ?? t('subServices')}</h3>
            </div>
            <div className={styles.flatList}>
              {detail.services.map(service => (
                <div key={service.id} className={styles.flatRow}>
                  <div className={styles.flatRowInfo}>
                    <span className={styles.flatRowTitle}>{service.name}</span>
                    {service.meta && <span className={styles.flatRowMeta}>{service.meta}</span>}
                  </div>
                  {service.actions && <div className={styles.flatRowActions}>{service.actions}</div>}
                </div>
              ))}
            </div>
          </section>
        )}

        {detail.extra}

        {(tools.length > 0 || detail.tools !== undefined) && (
          <section className={styles.detailPanel}>
            <div className={styles.panelHeader}>
              <h3 className={styles.panelTitle}>{fmt(t('connectorToolsCount'), { n: tools.length })}</h3>
              {tools.length > 6 && (
                <Input
                  className={styles.toolSearch}
                  icon={<IconSearchOutlineRegular size={14} />}
                  placeholder={t('searchTools')}
                  value={toolFilter}
                  onChange={e => setToolFilter(e.currentTarget.value)}
                />
              )}
            </div>
            {visibleTools.length > 0 ? (
              <ul className={styles.connectorTools}>
                {visibleTools.map(tool => (
                  <li key={`${tool.tag ?? ''}:${tool.name}`}>
                    <div>
                      <code>{tool.name}</code>
                      {tool.tag && <span className={styles.toolTag}> · {tool.tag}</span>}
                    </div>
                    {tool.description && <span>{tool.description}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.hint}>{t('noTools')}</p>
            )}
          </section>
        )}

        {plugin && plugin.skills.length > 0 && (
          <section className={styles.detailPanel}>
            <h3 className={styles.panelTitle}>{fmt(t('agentPluginSkills'), { n: plugin.skills.length })}</h3>
            <ul className={styles.connectorTools}>
              {plugin.skills.map(skill => (
                <li key={skill.name}>
                  <div>
                    <div className={styles.flatRowTitle}>{skill.name}</div>
                    <span className={styles.toolTag}>{fmt(t('agentPluginSkillSource'), { name: plugin.id })}</span>
                  </div>
                  {skill.description && <span>{skill.description}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {detail.maintenance && (
          <footer className={styles.maintenanceFooter}>
            <span className={styles.maintenanceLabel}>{t('maintenance')}</span>
            <div className={styles.detailActions}>{detail.maintenance}</div>
          </footer>
        )}

        {plugin && canManageAgentPlugins && (
          <footer className={styles.maintenanceFooter}>
            <span className={styles.maintenanceLabel}>{t('agentPluginManage')}</span>
            <div className={styles.detailActions}>
              <AgentPluginExport
                key={plugin.id}
                t={t}
                busy={busy !== undefined}
                onExport={format => exportAgentPlugin(plugin.id, format)}
              />
              {detail.id !== agentPluginDetailId(plugin.id) && (
                <Switch
                  checked={plugin.enabled}
                  disabled={busy !== undefined}
                  label={fmt(t('agentPluginToggle'), { name: plugin.name })}
                  onChange={() => void manageAgentPlugin(plugin, 'toggle')}
                />
              )}
              {plugin.imported && (
                <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={() => void manageAgentPlugin(plugin, 'remove')}>
                  {t('agentPluginRemove')}
                </Button>
              )}
            </div>
          </footer>
        )}
      </div>
    )
  }

  // Group MCP servers into single cards vs grouped connectors
  const groups = new Map<string, McpServerView[]>()
  const singles: McpServerView[] = []
  for (const server of servers) {
    const group = server.connectorPresentation?.group
    if (!group) singles.push(server)
    else {
      const listForGroup = groups.get(group.id)
      if (listForGroup) listForGroup.push(server)
      else groups.set(group.id, [server])
    }
  }

  const lang = language?.() ?? 'en'

  // Check if selectedId corresponds to a built-in single or group MCP connector
  const selectedSingle = selectedId ? singles.find(s => (s.connectorPresentation.id ?? s.serverName) === selectedId) : undefined
  const selectedGroup = selectedId ? groups.get(selectedId) : undefined
  const selectedAgentPlugin = selectedId ? agentPlugins.find(plugin =>
    agentPluginDetailId(plugin.id) === selectedId || plugin.connectorIds.includes(selectedId)) : undefined

  const wrapSection = (content: ReactNode) => (
    <div className={styles.page}><div className={styles.pageInner}>{content}</div></div>
  )

  const tabId = (tab: ConnectorTab) => `${tabsId}-${tab}`
  const panelId = (tab: ConnectorTab) => `${tabId(tab)}-panel`
  const tab = (value: ConnectorTab, label: LocaleKey) => ({
    value,
    label: <span className={styles.tabLabel} title={t(label)}>{t(label)}</span>,
    id: tabId(value),
    panelId: panelId(value),
  })
  const wrapOverview = (content: ReactNode, actions?: ReactNode) => wrapSection(
    <>
      <div className={styles.header}>
        {showTabs ? (
          <SegmentedTabs<ConnectorTab>
            size="sm"
            className={styles.tabs}
            label={t('tabsLabel')}
            value={activeTab}
            onChange={setRequestedTab}
            items={[
              tab('connectors', 'nav'),
              ...(hasSkills ? [tab('skills', 'skillsTab')] : []),
            ]}
          />
        ) : <h1 className={styles.pageTitle}>{t('nav')}</h1>}
        {actions}
      </div>
      {showTabs
        ? <div className={styles.tabPanel} role="tabpanel" id={panelId(activeTab)} aria-labelledby={tabId(activeTab)}>{content}</div>
        : content}
    </>,
  )

  const renderConnectorSlot = (props: ConnectorSlotProps) =>
    renderFactorySlot?.('connectors.cards', props) ?? renderSlot?.('settings.connectors.card', props)

  if (selectedSingle) {
    const pres = selectedSingle.connectorPresentation
    const id = pres.id ?? selectedSingle.serverName
    const link = connectorLink?.serverName === selectedSingle.serverName ? connectorLink : undefined
    const derived = deriveConnectorState(selectedSingle, busy === selectedSingle.serverName, Boolean(link))
    const canMaintain = derived.tone === 'connected' || derived.tone === 'error' || selectedSingle.authorized === true
    return wrapSection(renderDetailShell({
          id,
          name: pres.title,
          icon: pres.icon,
          description: pres.description[lang],
          status: t(derived.statusKey),
          tone: derived.tone,
          actions: renderPrimaryAction(selectedSingle, pres.title),
          notice: renderLinkNotice(selectedSingle.serverName, derived.tone === 'error' ? selectedSingle.error : undefined),
          tools: (selectedSingle.toolNames ?? []).map(name => ({ name })),
          maintenance: canMaintain ? (
            <>
              {derived.tone === 'connected' && (
                <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={() => void connectOrRetryServer(selectedSingle)}>
                  {t('reconnect')}
                </Button>
              )}
              {selectedSingle.enabled !== false && derived.tone === 'error' && (
                <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={() => toggleEnabled(selectedSingle.serverName, false)}>
                  {t('disable')}
                </Button>
              )}
              {selectedSingle.authorized && (
                <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={() => void revokeOAuth(selectedSingle.serverName)}>
                  {t('oauthRevokeBtn')}
                </Button>
              )}
            </>
          ) : undefined,
        }))
  }

  if (selectedGroup && selectedGroup.length > 0) {
    const group = selectedGroup[0].connectorPresentation.group!
    const memberStates = selectedGroup.map(member => ({
      member,
      derived: deriveConnectorState(member, busy === member.serverName, connectorLink?.serverName === member.serverName),
    }))
    const connectedCount = memberStates.filter(item => item.derived.tone === 'connected').length
    const groupTone: ConnectorTone = memberStates.some(item => item.derived.tone === 'connecting') ? 'connecting'
      : memberStates.some(item => item.derived.tone === 'error') ? 'error'
        : connectedCount > 0 ? 'connected' : 'disconnected'
    const groupStatus = connectedCount > 0
      ? fmt(t('groupStatus'), { n: connectedCount, total: selectedGroup.length })
      : t(groupTone === 'connecting' ? 'connecting' : groupTone === 'error' ? 'error' : 'disconnected')
    const allTools: ConnectorDetailTool[] = selectedGroup.flatMap(member =>
      (member.toolNames ?? []).map(toolName => ({ name: toolName, tag: member.connectorPresentation.title })),
    )
    const activeLinkMember = selectedGroup.find(member => connectorLink?.serverName === member.serverName)
    const anyAuthorized = selectedGroup.some(m => m.authorized)
    return wrapSection(renderDetailShell({
          id: group.id,
          name: group.title,
          icon: group.icon,
          description: group.description[lang],
          status: groupStatus,
          tone: groupTone,
          notice: activeLinkMember ? renderLinkNotice(activeLinkMember.serverName) : undefined,
          services: memberStates.map(({ member, derived }) => ({
            id: member.serverName,
            name: member.connectorPresentation.title,
            meta: [member.connectorPresentation.description[lang], derived.tone === 'error' && member.error ? member.error : t(derived.statusKey)]
              .filter(Boolean).join(' · '),
            actions: (
              <>
                {renderPrimaryAction(member, member.connectorPresentation.title)}
                {member.enabled !== false && derived.tone === 'error' && (
                  <Button variant="ghost" size="sm" disabled={busy !== undefined} onClick={() => toggleEnabled(member.serverName, false)}>
                    {t('disable')}
                  </Button>
                )}
              </>
            ),
          })),
          tools: allTools,
          maintenance: anyAuthorized ? (
            <>
              {selectedGroup.filter(m => m.authorized).map(m => (
                <Button key={m.serverName} variant="outline" size="sm" disabled={busy !== undefined}
                  onClick={() => void revokeOAuth(m.serverName)}>
                  {`${t('oauthRevokeBtn')} (${m.connectorPresentation.title})`}
                </Button>
              ))}
            </>
          ) : undefined,
        }))
  }

  if (selectedAgentPlugin && selectedId !== null) {
    const plugin = selectedAgentPlugin
    return wrapSection(renderDetailShell({
          id: selectedId,
          name: plugin.name,
          icon: plugin.icon,
          description: plugin.description[lang],
          status: t(plugin.enabled ? 'agentPluginEnabled' : 'agentPluginDisabled'),
          tone: plugin.enabled ? 'connected' : 'disconnected',
          actions: canManageAgentPlugins ? (
            <Switch
              checked={plugin.enabled}
              disabled={busy !== undefined}
              label={fmt(t('agentPluginToggle'), { name: plugin.name })}
              onChange={() => void manageAgentPlugin(plugin, 'toggle')}
            />
          ) : undefined,
        }))
  }

  // Slot-contributed detail view (e.g. Google Suite)
  if (selectedId !== null) {
    return wrapSection(renderConnectorSlot({
          activeDetailId: selectedId,
          openDetail: setSelectedId,
          closeDetail: () => setSelectedId(null),
          renderConnector: card => <ConnectorCard {...card} />,
          renderDetail: renderDetailShell,
        }))
  }

  if (activeTab === 'skills') return wrapOverview(renderSlot?.('connectors.skills', {}))

  const handleAddCustomServer = async (event: FormEvent) => {
    event.preventDefault()
    setFormError(undefined)
    const trimmedName = newName.trim()
    if (!SERVER_NAME_RE.test(trimmedName)) {
      setFormError(t('customNameInvalid'))
      return
    }
    if (newTransport === 'streamable-http' && !/^https?:\/\//.test(newUrl.trim())) {
      setFormError(t('customUrlInvalid'))
      return
    }
    if (newTransport === 'stdio' && !newCommand.trim()) {
      setFormError(t('customCommandRequired'))
      return
    }
    const payload = newTransport === 'streamable-http'
      ? {
        serverName: trimmedName,
        transport: 'streamable-http',
        url: newUrl.trim(),
        authType: newAuthType,
        enabled: true,
      }
      : {
        serverName: trimmedName,
        transport: 'stdio',
        command: newCommand.trim(),
        ...(newArgs.trim() ? { args: newArgs.trim().split(/\s+/) } : {}),
        ...(newCwd.trim() ? { cwd: newCwd.trim() } : {}),
        enabled: true,
      }
    setBusy(trimmedName)
    try {
      await request(`${API}/servers`, { method: 'POST', body: JSON.stringify(payload) })
      setNewName('')
      setNewUrl('')
      setNewCommand('')
      setNewArgs('')
      setNewCwd('')
      setShowAddForm(false)
      await refresh()
    } catch (err) {
      setFormError(err instanceof Error && err.message ? err.message : t('customAddFailed'))
    } finally {
      setBusy(undefined)
    }
  }

  const handleDeleteCustomServer = async (serverName: string) => {
    setBusy(serverName)
    setError(undefined)
    try {
      await request(`${API}/servers/${encodeURIComponent(serverName)}`, { method: 'DELETE' })
      await refresh()
    } catch {
      setError(t('customDeleteFailed'))
    } finally {
      setBusy(undefined)
    }
  }

  const connectorCards: ReactNode[] = singles.map(server => {
    const pres = server.connectorPresentation
    const id = pres.id ?? server.serverName
    const derived = deriveConnectorState(
      server,
      busy === server.serverName,
      connectorLink?.serverName === server.serverName,
    )
    return (
      <ConnectorCard
        key={server.serverName}
        id={id}
        name={pres.title}
        icon={pres.icon}
        description={pres.description[lang]}
        status={t(derived.statusKey)}
        tone={derived.tone}
        actions={renderPrimaryAction(server, pres.title)}
        onOpen={() => setSelectedId(id)}
      />
    )
  })

  for (const [id, groupServers] of groups) {
    const group = groupServers[0].connectorPresentation.group!
    const memberStates = groupServers.map(member =>
      deriveConnectorState(member, busy === member.serverName, connectorLink?.serverName === member.serverName),
    )
    const connectedCount = memberStates.filter(state => state.tone === 'connected').length
    const groupTone: ConnectorTone = memberStates.some(s => s.tone === 'connecting') ? 'connecting'
      : memberStates.some(s => s.tone === 'error') ? 'error'
        : connectedCount > 0 ? 'connected' : 'disconnected'
    const status = connectedCount > 0
      ? fmt(t('groupStatus'), { n: connectedCount, total: groupServers.length })
      : t(groupTone === 'connecting' ? 'connecting' : groupTone === 'error' ? 'error' : 'disconnected')

    connectorCards.push(
      <ConnectorCard
        key={id}
        id={id}
        name={group.title}
        icon={group.icon}
        description={group.description[lang]}
        status={status}
        tone={groupTone}
        actions={(
          <span className={styles.configureHint}>
            {t('configure')}
            <IconChevronRightOutlineRegular size={14} />
          </span>
        )}
        onOpen={() => setSelectedId(id)}
      />,
    )
  }

  const activeConnectorIds = new Set([
    ...groups.keys(),
    ...singles.map(server => server.connectorPresentation.id ?? server.serverName),
  ])
  for (const plugin of agentPlugins) {
    if (plugin.connectorIds.some(id => activeConnectorIds.has(id))) continue
    const id = agentPluginDetailId(plugin.id)
    connectorCards.push(
      <ConnectorCard
        key={id}
        id={id}
        name={plugin.name}
        icon={plugin.icon}
        description={plugin.description[lang]}
        status={t(plugin.enabled ? 'agentPluginEnabled' : 'agentPluginDisabled')}
        tone={plugin.enabled ? 'connected' : 'disconnected'}
        actions={(
          <span className={styles.configureHint}>
            {t('configure')}
            <IconChevronRightOutlineRegular size={14} />
          </span>
        )}
        onOpen={() => setSelectedId(id)}
      />,
    )
  }

  return wrapOverview(
    <>
      {error !== undefined && <p role="alert" className={styles.error}>{error}</p>}
      {loading && !servers.length && <p className={styles.hint}>{t('loading')}</p>}

      {canManageAgentPlugins && showPluginImport && (
        <AgentPluginImport
          t={t}
          busy={busy !== undefined}
          pickDirectory={pickPluginDirectory}
          onPreview={previewAgentPlugin}
          onDiscover={discoverAgentPlugins}
          onImport={async input => { await importAgentPlugin(input) }}
          onDiscard={discardAgentPlugin}
          onClose={() => setShowPluginImport(false)}
        />
      )}

      <div className={connectorGrid}>
        {connectorCards}
        {renderConnectorSlot({
          activeDetailId: selectedId,
          openDetail: setSelectedId,
          closeDetail: () => setSelectedId(null),
          renderConnector: card => <ConnectorCard {...card} />,
          renderDetail: renderDetailShell,
        })}
      </div>

      <section className={styles.customSection}>
        <div className={styles.panelHeader}>
          <h3 className={styles.panelTitle}>{t('customSectionTitle')}</h3>
          <Button
            variant="outline"
            size="sm"
            icon={<IconPlusOutlineRegular size={14} />}
            onClick={() => { setShowAddForm(v => !v); setFormError(undefined) }}
          >
            {showAddForm ? t('cancel') : t('customAdd')}
          </Button>
        </div>

        {showAddForm && (
          <form className={styles.customForm} onSubmit={e => void handleAddCustomServer(e)}>
            {formError && <p role="alert" className={styles.error}>{formError}</p>}
            <div className={styles.customFormRow}>
              <label className={styles.field}>
                <span>{t('customServerName')}</span>
                <Input value={newName} onChange={e => setNewName(e.currentTarget.value)} placeholder="my-mcp" />
              </label>
              <label className={styles.field}>
                <span>{t('customTransport')}</span>
                <select
                  className={styles.select}
                  value={newTransport}
                  onChange={e => setNewTransport(e.currentTarget.value as 'streamable-http' | 'stdio')}
                >
                  <option value="streamable-http">streamable-http</option>
                  <option value="stdio">stdio</option>
                </select>
              </label>
            </div>

            {newTransport === 'streamable-http' ? (
              <div className={styles.customFormRow}>
                <label className={styles.field}>
                  <span>{t('customUrl')}</span>
                  <Input value={newUrl} onChange={e => setNewUrl(e.currentTarget.value)} placeholder="https://example.com/mcp" />
                </label>
                <label className={styles.field}>
                  <span>{t('customAuthType')}</span>
                  <select
                    className={styles.select}
                    value={newAuthType}
                    onChange={e => setNewAuthType(e.currentTarget.value as 'none' | 'oauth')}
                  >
                    <option value="none">{t('customAuthNone')}</option>
                    <option value="oauth">{t('customAuthOAuth')}</option>
                  </select>
                </label>
              </div>
            ) : (
              <>
                <div className={styles.customFormRow}>
                  <label className={styles.field}>
                    <span>{t('customCommand')}</span>
                    <Input value={newCommand} onChange={e => setNewCommand(e.currentTarget.value)} placeholder="npx" />
                  </label>
                  <label className={styles.field}>
                    <span>{t('customArgs')}</span>
                    <Input value={newArgs} onChange={e => setNewArgs(e.currentTarget.value)} placeholder="-y @modelcontextprotocol/server-..." />
                  </label>
                </div>
                <label className={styles.field}>
                  <span>{t('customCwd')}</span>
                  <Input value={newCwd} onChange={e => setNewCwd(e.currentTarget.value)} />
                </label>
              </>
            )}

            <div className={styles.noticeActions}>
              <Button type="submit" variant="primary" size="sm" disabled={busy !== undefined}>
                {t('customSave')}
              </Button>
            </div>
          </form>
        )}

        {customServers.length > 0 ? (
          <div className={styles.flatList}>
            {customServers.map(server => {
              const derived = deriveConnectorState(
                server,
                busy === server.serverName,
                connectorLink?.serverName === server.serverName,
              )
              const endpoint = server.transport === 'stdio'
                ? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
                : (server.url ?? '')
              return (
                <Fragment key={server.serverName}>
                  <div className={styles.flatRow}>
                    <div className={styles.flatRowInfo}>
                      <span className={styles.flatRowTitle}>
                        <StateDot state={dotStates[derived.tone]} size={8} />
                        <span>{server.serverName}</span>
                      </span>
                      <span className={styles.flatRowMeta}>
                        {[t(derived.statusKey), endpoint, server.toolNames?.length ? `${server.toolNames.length} tools` : undefined]
                          .filter(Boolean).join(' · ')}
                      </span>
                    </div>
                    <div className={styles.flatRowActions}>
                      {renderPrimaryAction(server, server.serverName)}
                      {server.enabled !== false && derived.tone === 'error' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy !== undefined}
                          onClick={() => toggleEnabled(server.serverName, false)}
                        >
                          {t('disable')}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy !== undefined}
                        onClick={() => void handleDeleteCustomServer(server.serverName)}
                      >
                        {t('customDelete')}
                      </Button>
                    </div>
                  </div>
                  {renderLinkNotice(server.serverName)}
                </Fragment>
              )
            })}
          </div>
        ) : (
          !showAddForm && <p className={styles.hint}>{t('customEmpty')}</p>
        )}
      </section>
    </>,
    <div className={styles.detailActions}>
      {canManageAgentPlugins && !showPluginImport && (
        <Button
          variant="outline"
          size="sm"
          icon={<IconFolderOpenOutlineRegular size={14} />}
          disabled={busy !== undefined}
          onClick={() => setShowPluginImport(true)}
        >
          {t('agentPluginImport')}
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        className={styles.iconButton}
        icon={<IconRefreshOutlineRegular size={16} />}
        aria-label={t('refresh')}
        title={t('refresh')}
        disabled={loading}
        onClick={() => void refresh()}
      />
    </div>,
  )
}

function ConnectorCardsHost({ renderSlot, ...props }: ConnectorSlotProps & {
  renderSlot: (name: 'settings.connectors.card', slotProps: ConnectorSlotProps) => ReactNode
}) {
  return renderSlot('settings.connectors.card', props)
}

/** Services required by this client plugin. */
export const inject = ['slots', 'locale']

/** Register the Connectors page in the application sidebar. */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mcp-manager: dictionaries')

  const slots = ctx.slots as unknown as {
    registerFactory(options: object, component: unknown): () => void
    inject(name: string, factory: () => unknown): () => void
    register(options: object, component: unknown): () => void
    entries(name: string): readonly unknown[]
    subscribe(name: string, listener: () => void): () => void
  }
  const skillsSlot = {
    getSnapshot: () => slots.entries('connectors.skills').length > 0,
    subscribe: (listener: () => void) => slots.subscribe('connectors.skills', listener),
  }

  const injected = () => ({
    skillsSlot,
    language: () => ctx.locale.getLocale().active === 'zh' ? 'zh' : 'en',
    list: async () => {
      const body = await request<{ servers: McpServerView[] }>(`${API}/connectors`)
      return body.servers
    },
    listAll: async () => {
      const body = await request<{ servers: CustomMcpServer[] }>(`${API}/servers`)
      return body.servers
    },
    listAgentPlugins: () => request<{ plugins: AgentPluginView[]; canManage: boolean }>(`${API}/agent-plugins`),
    pickPluginDirectory: async () => {
      const desktop = (window as Window & { __DSH_DIRECTORY_PICKER__?: { pick(): Promise<string | null> } }).__DSH_DIRECTORY_PICKER__
      if (desktop) return desktop.pick()
      const workspace = ctx.get('uiWorkspace') as { pickDirectory(): Promise<string | null> } | undefined
      if (!workspace) throw new Error(t('agentPluginBrowseFailed'))
      return workspace.pickDirectory()
    },
    setEnabled: async (serverName: string, enabled: boolean) => {
      const body = await request<{ ok: boolean }>(`${API}/servers/${encodeURIComponent(serverName)}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      if (!body.ok) throw new Error(t('toggleFailed'))
    },
    reconnect: async (serverName: string) => {
      await request<{ ok: boolean }>(`${API}/servers/${encodeURIComponent(serverName)}/reconnect`, { method: 'POST' })
    },
  })

  slots.registerFactory({
    name: 'connectors.cards',
    scope: 'root',
    children: { 'settings.connectors.card': { kind: 'list', scope: 'root' } },
  }, ConnectorCardsHost)

  slots.inject('main', () => slots.register({
    name: 'main',
    key: 'connectors',
    locale: NS,
    children: { 'connectors.skills': { kind: 'single', scope: 'root' } },
    inject: injected,
  }, McpManagerSection))

  slots.inject('sidebar.panellist', () => slots.register({
    name: 'sidebar.panellist',
    id: 'connectors',
    order: 5,
    label: () => t('nav'),
    locale: NS,
  }, ConnectorsPanelIcon))
}
