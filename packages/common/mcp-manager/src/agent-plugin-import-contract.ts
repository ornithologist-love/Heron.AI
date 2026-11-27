export const AGENT_PLUGIN_ZIP_LIMIT = 16 * 1024 * 1024

export const AGENT_PLUGIN_DISCOVERY_SOURCES = ['codex', 'claude-code', 'antigravity'] as const
export type AgentPluginDiscoverySource = typeof AGENT_PLUGIN_DISCOVERY_SOURCES[number]
export type AgentPluginImportFormat = 'standard' | AgentPluginDiscoverySource

export type AgentPluginImportInput =
  | { directory: string }
  | { fileName: string; zipBytes: Uint8Array }
  | { source: AgentPluginDiscoverySource; candidate: string }

export interface AgentPluginCandidate {
  id: string
  name: string
}

export interface AgentPluginPreview {
  id: string
  name: string
  format: AgentPluginImportFormat
  servers: Array<{ id: string; command?: string; args?: string[] }>
  skills: Array<{ name: string }>
  warnings?: string[]
}

export interface AgentPluginCommitInput {
  id: string
  serverIds: string[]
  skillNames: string[]
  allowStdio: boolean
}
