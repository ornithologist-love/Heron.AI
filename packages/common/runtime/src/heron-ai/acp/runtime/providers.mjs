// Catalog data is shared; executable and credential bindings stay local.
import { bundledDirectory } from './provider-directory.mjs'
export const ai_provider_definitions = []
let directory
export function configureProviderDirectory(value) {
  directory = value
  ai_provider_definitions.splice(0, ai_provider_definitions.length, ...Object.entries(value.providers).map(([id, row]) => {
    const apiKeyEnv = id.replace(/[^A-Za-z0-9]/g, '_').toUpperCase() + '_API_KEY'
    return { id, name: row.name, transport: 'llm', public: row.public === true, integration: row.integration, capabilities: row.capabilities,
      credential: row.credential, llm: { settings_file: id + '-provider.json',
        environment_from_settings: { [apiKeyEnv]: 'api_key' }, api_key_env: apiKeyEnv,
        default_base_url: row.base_url, default_api: row.api } }
  }))
}
configureProviderDirectory(bundledDirectory)
export const provider_definition = id => ai_provider_definitions.find(item => item.id === id)
export const is_model_provider = id => provider_definition(id)?.transport === 'llm'
export const provider_capabilities = id => provider_definition(id)?.capabilities ?? { skills: 'none', mcp: 'none', sessions: 'local' }
export const provider_native_sessions = id => provider_capabilities(id).sessions === 'native'
export const provider_has_local_skills = id => provider_capabilities(id).skills === 'local'
export const provider_requires_mcp_setup = id => provider_capabilities(id).mcp === 'local'
export function defaultSelection(publicHost = false) {
  const provider = publicHost ? directory.public_default_provider ?? directory.default_provider : directory.default_provider
  return provider ? { provider, model: directory.providers[provider].default_model } : undefined
}
