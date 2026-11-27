export type ConnectorTone = 'disconnected' | 'connecting' | 'connected' | 'error'
export type ConnectorPrimaryAction = 'connect' | 'cancel' | 'toggle' | 'retry'
export type ConnectorTab = 'connectors' | 'skills'

export function connectorOverview(requestedTab: ConnectorTab, hasSkills: boolean, selectedId: string | null) {
  const showTabs = hasSkills && selectedId === null
  const canSelectTab = requestedTab === 'connectors' || (requestedTab === 'skills' && hasSkills)
  return { showTabs, activeTab: showTabs && canSelectTab ? requestedTab : 'connectors' as const }
}

export interface ConnectorStateInput {
  serverName: string
  enabled?: boolean
  status?: string
  authType?: 'none' | 'oauth'
  authorized?: boolean
  error?: string
  connectorPresentation?: unknown
}

export interface DerivedConnectorState {
  tone: ConnectorTone
  action: ConnectorPrimaryAction
  statusKey: 'connectorConnected' | 'connectorWaiting' | 'connecting' | 'disconnected' | 'error'
}

/** Collapse raw enabled/oauth/transport states into 4 user-facing states with 1 primary action. */
export function deriveConnectorState(
  server: ConnectorStateInput,
  isBusy: boolean,
  hasPendingLink: boolean,
): DerivedConnectorState {
  const disabled = server.enabled === false
  if (hasPendingLink || isBusy || (!disabled && server.status === 'connecting')) {
    return {
      tone: 'connecting',
      action: 'cancel',
      statusKey: hasPendingLink ? 'connectorWaiting' : 'connecting',
    }
  }
  if (disabled) {
    return { tone: 'disconnected', action: 'connect', statusKey: 'disconnected' }
  }
  if (server.status === 'connected') {
    return { tone: 'connected', action: 'toggle', statusKey: 'connectorConnected' }
  }
  if (server.status === 'disconnected') {
    return { tone: 'disconnected', action: 'connect', statusKey: 'disconnected' }
  }
  return { tone: 'error', action: 'retry', statusKey: 'error' }
}

/** Partition /api/servers entries into custom user servers (excluding declarative connectors). */
export function filterCustomServers<T extends ConnectorStateInput>(servers: readonly T[]): T[] {
  return servers.filter(server => !server.connectorPresentation)
}
