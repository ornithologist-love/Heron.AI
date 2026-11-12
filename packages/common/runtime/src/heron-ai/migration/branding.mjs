import fs from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

const identifiersFile = new URL('./legacy-identifiers.json', import.meta.url)
const identifiers = existsSync(identifiersFile) ? JSON.parse(readFileSync(identifiersFile, 'utf8')) : {}

const exists = file => fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
const hash = value => createHash('sha256').update(value).digest('hex')

// Explicit compatibility reads are confined to this module and its mapping table.
export async function prepareStateDirectory({ stateDir, home = os.homedir() } = {}) {
  const target = path.join(home, '.heron-ai')
  if (stateDir && path.resolve(stateDir) !== path.resolve(target)) return path.resolve(stateDir)
  return withFileLock(path.join(home, '.heron-ai-migration'), async () => {
    const previous = path.join(home, '.ksfai')
    let moved = false
    try {
    if (!await exists(target) && await exists(previous)) {
      // Rename is atomic; failure leaves the original state intact and aborts startup.
      await fs.rename(previous, target)
      moved = true
    }
    const legacy = path.join(home, '.dsh-ksf', 'chats')
    if (await exists(legacy)) {
      const copy = async (source, destination) => {
        const stat = await fs.lstat(source)
        if (stat.isSymbolicLink()) throw Error('Legacy chat migration refuses symbolic links')
        if (stat.isDirectory()) {
          await fs.mkdir(destination, { recursive: true })
          for (const name of await fs.readdir(source)) await copy(path.join(source, name), path.join(destination, name))
        } else if (stat.isFile()) {
          const bytes = await fs.readFile(source)
          if (await exists(destination)) {
            if (hash(await fs.readFile(destination)) === hash(bytes)) return
            destination += '.legacy-' + hash(bytes).slice(0, 16)
          }
          if (!await exists(destination)) await writeFileAtomic(destination, bytes, { mode: 0o600 })
        }
      }
      await copy(legacy, path.join(target, 'chats'))
    }
    return target
    } catch (error) {
      if (moved) await fs.rename(target, previous)
      throw error
    }
  }, { waitMs: 30000 })
}

export function renamedIdentifier(value) {
  if (typeof value !== 'string') return value
  if (value.startsWith('ksf-acp-')) return 'heron-ai-acp-' + value.slice(8)
  if (value.startsWith('preset-ksf-acp-')) return 'preset-heron-ai-acp-' + value.slice(15)
  return identifiers[value] ?? (value.startsWith('KSFAI_') ? 'HERON_AI_' + value.slice(6)
    : value.startsWith('KSF_AI_') ? 'HERON_AI_' + value.slice(7)
    : value.startsWith('KSF_') ? 'HERON_AI_' + value.slice(4) : value)
}

// Only known product identifiers in configuration are converted. No session log,
// credential value, user path or arbitrary string prefix is rewritten.
function configValue(value, field = '') {
  if (typeof value === 'string') return /token|secret|password|apiKey/i.test(field) && !/Env|Ref$/.test(field) ? value : renamedIdentifier(value)
  if (Array.isArray(value)) return value.map(item => configValue(item, field))
  if (!value || typeof value !== 'object') return value
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return value
  const result = Object.create(null)
  // New spellings win on conflict; old entries remain in the byte-for-byte backup.
  for (const [key, item] of Object.entries(value)) {
    const name = renamedIdentifier(key)
    if (key !== name && Object.hasOwn(value, name)) continue
    result[name] = configValue(item, key)
  }
  return result
}

export async function migrateProductSettings(options) {
  await fs.mkdir(options.stateDir, { recursive: true })
  await withFileLock(path.join(options.stateDir, '.heron-ai-identifiers'), async () => {
    const rewrite = async (file, transform, profile = false) => {
      let text
      try { text = await fs.readFile(file, 'utf8') } catch (error) { if (error.code === 'ENOENT') return; throw error }
      const json = file.endsWith('.json')
      const schema = profile ? entryListSchema : yaml.DEFAULT_SCHEMA
      const value = json ? JSON.parse(text) : yaml.load(text, { schema })
      const next = transform(value)
      if (JSON.stringify(value) === JSON.stringify(next)) return
      // Backup is durable before replacing any configuration file. Re-running is idempotent.
      const backup = file + '.before-heron-ai-' + hash(text).slice(0, 16) + '.bak'
      try { await fs.writeFile(backup, text, { flag: 'wx', mode: 0o600 }) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
      await writeFileAtomic(file, json ? JSON.stringify(next, null, 2) + '\n'
        : yaml.dump(next, { schema, noRefs: true, lineWidth: -1 }), { mode: 0o600 })
    }
    for (const [oldName, newName] of [['dsh/migration/ksf-v1', 'dsh/migration/heron-ai-v1'], ['.agents/.ksf-skills-v2', '.agents/.heron-ai-skills-v2'], ['.agents/inactive-ksf-skills', '.agents/inactive-heron-ai-skills']]) {
      const source = path.join(options.stateDir, oldName), target = path.join(options.stateDir, newName)
      if (await exists(source) && !await exists(target)) await fs.rename(source, target)
    }
    await rewrite(path.join(options.home, 'settings.yaml'), value => {
      const result = Object.create(null)
      for (const [key, item] of Object.entries(value ?? {})) {
        const name = renamedIdentifier(key)
        if (key !== name && Object.hasOwn(value, name)) continue
        result[name] = name !== key || ['ui-theme', 'common-brand'].includes(key) ? configValue(item) : item
      }
      return result
    })
    // Native credentials are opaque. Add renamed refs without touching record/value bytes.
    await rewrite(path.join(options.home, '.credentials.yaml'), value => {
      if (!value || typeof value !== 'object') throw Error('Invalid credentials document; original preserved')
      const next = structuredClone(value)
      const refs = next.version === undefined ? next : next.refs
      for (const [key, secret] of Object.entries(refs ?? {})) {
        const name = renamedIdentifier(key)
        if (name !== key && !Object.hasOwn(refs, name)) refs[name] = secret
      }
      return next
    })
    const profiles = path.join(options.home, 'profiles')
    const names = await fs.readdir(profiles).catch(error => { if (error.code === 'ENOENT') return []; throw error })
    for (const name of names) {
      const directory = path.join(profiles, name)
      if (!(await fs.lstat(directory)).isDirectory()) continue
      await rewrite(path.join(directory, 'cordis.patch.yml'), value => {
        if (!Array.isArray(value)) throw Error('Invalid profile patch; original preserved')
        const visit = rows => rows.filter(row => !row.id || renamedIdentifier(row.id) === row.id || !rows.some(other => other.id === renamedIdentifier(row.id))).map(row => ({ ...row,
          ...(row.id && { id: renamedIdentifier(row.id) }),
          ...(row.name && { name: renamedIdentifier(row.name) }),
          ...(row.config && { config: renamedIdentifier(row.id) !== row.id || ['ui-theme', 'common-brand'].includes(row.id) ? configValue(row.config) : row.config }),
          ...(row.insert && { insert: visit(row.insert) }),
        }))
        return visit(value)
      }, true)
      await rewrite(path.join(directory, 'package.json'), value => {
        const next = structuredClone(value)
        for (const field of ['dependencies', 'devDependencies']) {
          if (!next[field]) continue
          // Generated profile packages are replaced by launchDsh, not fetched from npm.
          for (const key of Object.keys(next[field])) if (key === '@ksf/dsh-profile') delete next[field][key]
        }
        if (next.dsh?.profile?.bundles) next.dsh.profile.bundles = next.dsh.profile.bundles.map(renamedIdentifier)
        if (next.ksfai) { next.heronAi ??= next.ksfai; delete next.ksfai }
        return next
      })
    }
  }, { waitMs: 30000 })
}

// Old sessions keep their original event bytes and preset identities. Hidden
// aliases let those sessions resume without rewriting conversation records.
export const legacyPresetPrefixes = ['ksf-acp-']
export function legacyPresetAliases(presets) {
  return presets.map(row => ({ ...row, id: 'legacy-' + row.id,
    config: { ...row.config, id: legacyPresetPrefixes[0] + row.config.id.slice('heron-ai-acp-'.length) } }))
}

