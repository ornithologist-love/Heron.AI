// Type declarations for providers.mjs so the ChatWeb frontend (vue-tsc) can
// import the shared provider definitions without allowJs.

export type ProviderTransport = 'llm'
export type ProviderSkills = 'none' | 'local' | 'remote' | 'dsh'
export type ProviderMcp = 'none' | 'local' | 'remote' | 'dsh'
/** DSH owns native sessions; `local` is kept for catalogs that still declare it. */
export type ProviderSessions = 'native' | 'local'
export interface ProviderCapabilities {
  skills: ProviderSkills
  mcp: ProviderMcp
  sessions: ProviderSessions
}
export interface ProviderCredential {
  field: string
  label: string
  placeholder?: string
  help_url?: string
  help_label?: string
}
export interface ModelProviderConfig {
  settings_file?: string
  environment_from_settings?: Record<string, string>
  /** Environment variable carrying the provider token to the native LLM adapter. */
  api_key_env?: string
  catalog?: { default_model: string; api: string; models: Record<string, unknown>[] }
  /** Endpoint used only when the Server catalog predates endpoint config. */
  default_base_url?: string
  default_api?: string
}
export interface ProviderDefinition {
  id: string
  name: string
  /** Attached by the UI shell (providers.ts); not present in the shared Node module. */
  icon?: string
  transport: ProviderTransport
  capabilities: ProviderCapabilities
  llm?: ModelProviderConfig
  public?: boolean
  integration?: string
  credential?: ProviderCredential
}
export declare const ai_provider_definitions: ProviderDefinition[]
export declare function provider_definition(id: string): ProviderDefinition | undefined
export declare function provider_capabilities(id: string): ProviderCapabilities
export declare function provider_has_local_skills(id: string): boolean
export declare function provider_native_sessions(id: string): boolean
export declare function provider_requires_mcp_setup(id: string): boolean
export declare function is_model_provider(id: string): boolean
export declare function configureProviderDirectory(value: object): void
export declare function defaultSelection(publicHost?: boolean): { provider: string; model: string } | undefined
