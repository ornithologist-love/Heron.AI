import { migrateProductSettings } from './migration/branding.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { deployBundledSkills } from './runtime/skill-roots.mjs'
import { prepareComposition } from './composition.mjs'
import { migrateConfiguration } from './migration/config.mjs'
import { prepareRcSettings } from './migration/settings-rc.mjs'
import { providerDirectory, providerCatalogUrl, refreshBundledDirectory } from './acp/runtime/provider-directory.mjs'
import { configureProviderDirectory } from './acp/runtime/providers.mjs'
import { initializeProductContent } from './product-profile.mjs'
import { prepareIntegrationOptions } from './integrations.mjs'

export async function prepareHeronAi(options) {
  await migrateProductSettings(options)
  initializeProductContent({ stateDir: options.stateDir })
  await prepareIntegrationOptions(options)
  // An integration may route this host's personal Provider calls through a model gateway.
  options.managedModelGateway = !options.automation && !!(options.modelGatewayUrl ?? process.env.HERON_AI_MODEL_GATEWAY_URL)
    && options.modelGatewayMode !== 'remote'
  refreshBundledDirectory()
  options.providerCatalogUrl ??= providerCatalogUrl(options.serverUrl)
  const directory = await providerDirectory({ stateDirectory: options.stateDir, catalogUrl: options.providerCatalogUrl }).load()
  configureProviderDirectory(directory)
  options.providerCatalogSnapshot = directory
  await prepareRcSettings(options)
  await migrateConfiguration(options)
  await fs.mkdir(options.skillsDir, { recursive: true })
  await fs.mkdir(options.templatesDir, { recursive: true })
  try { await fs.writeFile(path.join(options.templatesDir, 'index.json'), '{"version":1,"templates":[]}\n', { flag: 'wx' }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  deployBundledSkills(options.skillsDir, options.stateDir)
  return prepareComposition(options)
}
