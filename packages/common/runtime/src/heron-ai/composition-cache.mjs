import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { productProfileFile } from './product-profile.mjs'
import { integrationFingerprint, integrationConfigurationKey } from './integrations.mjs'

async function compositionKey(config) {
  const root = path.join(config.hostRoot, 'heron-ai'), files = []
  const walk = async directory => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!['node_modules', 'web', 'ui', 'content'].includes(entry.name)) await walk(path.join(directory, entry.name))
      } else if (entry.isFile() && /\.(mjs|js|json|css|png|ico|svg)$/.test(entry.name)) files.push(path.join(directory, entry.name))
    }
  }
  await walk(root)
  files.push(path.join(config.hostRoot, 'node_modules', '.package-lock.json'))
  files.push(path.join(config.hostRoot, 'node_modules', '.heron-ai-dsh-forks.json'))
  // Business compose() modules and persona now live outside heron-ai/. Their
  // contents can change without changing package versions or the lockfile.
  files.push(path.join(config.hostRoot, '.heron-ai-assembly.json'))
  if (config.brandLogo) files.push(config.brandLogo)
  files.sort()
  const bytes = await Promise.all(files.map(file => fs.readFile(file)))
  const hash = createHash('sha256').update(JSON.stringify({ version: 2, hostRoot: config.hostRoot,
    branding: config.branding, themes: config.heronAiThemes, theme: config.hostTheme, hostIntegration: config.hostIntegration, skillsDir: config.skillsDir,
    aspects: config.aspects, localRoot: config.localRoot, identityFile: config.identityFile, identityHeader: config.identityHeader,
    hostEdition: config.hostEdition, managedModelGateway: config.managedModelGateway,
    hostMetadata: config.hostMetadata,
    providerCatalogSnapshot: config.providerCatalogSnapshot, productProfileSource: productProfileFile.href,
    integrations: await integrationFingerprint(), preferPublicDefault: config.preferPublicDefault, automation: config.automation === true,
    contributedConfiguration: await integrationConfigurationKey(config),
    includeUserSkillRoots: config.includeUserSkillRoots }))
  for (let index = 0; index < files.length; index++) hash.update(files[index]).update('\0').update(bytes[index]).update('\0')
  return hash.digest('hex').slice(0, 24)
}

export async function cachedComposition(config, build) {
  const root = path.join(config.stateDir, 'runtime', 'modules-' + await compositionKey(config))
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const manifest = path.join(root, 'composition.json')
  const rows = await withFileLock(path.join(root, 'build'), async () => {
    try {
      const cached = JSON.parse(await fs.readFile(manifest, 'utf8'))
      if (Array.isArray(cached) && cached.every(row => row && typeof row.name === 'string')
          && cached.some(row => row.id === 'heron-ai' && row.config !== undefined)) {
        // A removed/partial generated package is repairable cache damage.
        await Promise.all(cached.map(row => fs.access(row.name.startsWith('file:')
          ? fileURLToPath(row.name) : path.join(root, 'node_modules', row.name, 'package.json'))))
        return cached
      }
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
    const prepared = await build(config, root)
    // Process tokens, ports and readiness destinations belong only in the
    // invocation include, never in the reusable generated-module manifest.
    const reusable = prepared.map(row => row.config === config ? { ...row, config: {}, invocationConfig: true } : row)
    await writeFileAtomic(manifest, JSON.stringify(reusable), { mode: 0o600, dirMode: 0o700 })
    return reusable
  }, { waitMs: 30000 })
  if (!Array.isArray(rows) || !rows.some(row => row.id === 'heron-ai')) throw Error('Generated DSH composition cache is invalid')
  const current = rows.map(row => {
    if (!row.invocationConfig) return row
    const { invocationConfig, ...entry } = row
    return { ...entry, config }
  })
  const include = path.join(root, `host-${process.pid}.cordis.yml`)
  await writeFileAtomic(include, JSON.stringify(current, null, 2), { mode: 0o600, dirMode: 0o700 })
  return include
}
