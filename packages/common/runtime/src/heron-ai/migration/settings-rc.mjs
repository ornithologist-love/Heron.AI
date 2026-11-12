// Re-address the retired preset setting before DSH performs its one-time import.
import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import { createHash } from 'node:crypto'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { pathToFileURL } from 'node:url'

// ConfigEditor records a plugin name as well as its id. Generated-cache names
// must be re-addressed before the Loader applies the saved profile layer.
export async function prepareRcProfileEntries(profileDir, stateDir, entries, productThemes = []) {
  const file = path.join(profileDir, 'cordis.patch.yml')
  await withFileLock(path.join(profileDir, 'package.json'), async () => {
    let text
    try { text = await fs.readFile(file, 'utf8') }
    catch (error) { if (error.code === 'ENOENT') return; throw error }
    const rows = yaml.load(text, { schema: entryListSchema })
    if (!Array.isArray(rows)) throw Error('新版配置补丁格式无效，原文件已保留。')
    const generated = pathToFileURL(path.join(stateDir, 'runtime')).href + '/modules-'
    let changed = false
    for (const row of rows) {
      const entry = entries.get(row.id)
      if (entry && row.name !== entry.name) { row.name = entry.name; changed = true }
    }
    // The product's full-access acknowledgement moves to the official permission row.
    const confirmations = rows.find(row => row.id === 'heron-ai-permission-confirmations')
    if (confirmations) {
      if (confirmations.config?.fullAccess === true) {
        let permission = rows.find(row => row.id === 'ui-permission' || row.id === 'heron-ai-permission-selection')
        if (!permission) rows.push(permission = { id: 'ui-permission', name: '@deepseek-ai/dsh-client-ui-permission-presets', config: {} })
        permission.config = { ...permission.config, fullAccessAcknowledged: true }
      }
      rows.splice(rows.indexOf(confirmations), 1)
      changed = true
    }
    // Retired replacements: a saved row moves back under the native id (or is
    // dropped when the replacement had no settings); the retired values win.
    for (const [retiredId, nativeId, nativeName] of [
      ['common-agent-presets', 'agent-preset-registry'],
      ['heron-ai-layout'],
      ['heron-ai-settings-shell', 'ui-settings-general', '@deepseek-ai/dsh-client-ui-settings-general'],
      ['common-directory-picker', 'directory-picker', '@deepseek-ai/dsh-host-directory-picker-auto'],
      ['heron-ai-model-settings', 'ui-settings-models', '@deepseek-ai/dsh-client-ui-settings-models'],
      ['heron-ai-deliverables', 'ui-deliverables', '@deepseek-ai/dsh-client-ui-deliverables'],
      ['heron-ai-chat', 'ui-chat', '@deepseek-ai/dsh-client-ui-chat'],
      ['heron-ai-model-selection'],
      ['common-workspace', 'workspace', '@deepseek-ai/dsh-workspace'],
      ['common-sandbox', 'sandbox', '@deepseek-ai/dsh-sandbox-local'],
      ['common-sandbox-policy', 'sandbox-policy', '@deepseek-ai/dsh-sandbox-policy'],
      ['common-fs-sandbox', 'fs-sandbox', '@deepseek-ai/dsh-fs-sandbox'],
      ['heron-ai-session-controller', 'session-controller', '@deepseek-ai/dsh-api-session-controller'],
      ['common-file-upload', 'file-upload', '@deepseek-ai/dsh-client-file-upload'],
      ['common-remotes', 'api-remotes', '@deepseek-ai/dsh-api-remotes'],
      ['heron-ai-commands', 'ui-commands', '@deepseek-ai/dsh-client-ui-commands'],
      ['heron-ai-permission-selection', 'ui-permission', '@deepseek-ai/dsh-client-ui-permission-presets'],
      ['heron-ai-preset-selection', 'ui-agent-preset', '@deepseek-ai/dsh-client-ui-agent-preset'],
      ['heron-ai-workspace-ui'],
      ['heron-ai-conversation', 'ui-conversation', '@deepseek-ai/dsh-client-ui-conversation'],
    ]) {
      const retired = rows.find(row => row.id === retiredId)
      if (!retired) continue
      const native = nativeId && rows.find(row => row.id === nativeId)
      if (native) native.config = { ...native.config, ...retired.config }
      if (native || !nativeId) rows.splice(rows.indexOf(retired), 1)
      else Object.assign(retired, { id: nativeId }, nativeName ? { name: nativeName } : {})
      changed = true
    }
    // Thin replacements retain saved preferences under their product row ids.
    for (const [legacyId, id, packageId = legacyId, prefix = '@deepseek-ai/dsh-client-'] of [
      ['heron-ai-mcp-manager', 'heron-ai-mcp-manager', 'dsh-mcp-manager', ''],
      ['heron-ai-skill-manager', 'heron-ai-skill-manager', 'dsh-skill-manager', ''],
      ['ui-conversation', 'ui-conversation'],
      ['ui-permission', 'ui-permission'],
      ['ui-agent-preset', 'ui-agent-preset'],
      ['agent-preset-registry', 'agent-preset-registry', 'agent-preset-registry', '@deepseek-ai/dsh-'],
    ]) {
      const entry = entries.get(id)
      if (!entry) continue
      const previous = legacyId === id ? undefined : rows.find(row => row.id === legacyId && row.name === prefix + packageId)
      if (previous) {
        const current = rows.find(row => row.id === id)
        if (current) {
          current.config = { ...previous.config, ...current.config }
          rows.splice(rows.indexOf(previous), 1)
        } else {
          previous.id = id
          previous.name = entry.name
        }
        changed = true
      }
      const saved = rows.find(row => row.id === id)
      if (!saved) continue
      if (saved.name !== entry.name) {
        saved.name = entry.name
        changed = true
      }
      // Profile config replaces the composed object; retain presentation fields
      // when an older settings row only stored selected preferences.
      for (const [key, value] of Object.entries(entry.config ?? {})) {
        if (Object.hasOwn(saved.config ?? {}, key)) continue
        saved.config ??= {}
        saved.config[key] = value
        changed = true
      }
    }
    if (!rows.some(row => row.id === 'heron-ai-llm-pi-ai')) {
      const previous = rows.find(row => row.id === 'llm-pi-ai' && row.name === '@deepseek-ai/dsh-llm-pi-ai')
      if (previous) {
        previous.id = 'heron-ai-llm-pi-ai'
        previous.name = entries.get(previous.id).name
        changed = true
      }
    }
    // HERON_AI palettes used to live in DSH's own theme setting. DSH keeps only
    // light/dark/system; a saved palette moves to heron-ai-theme-preference and the
    // palette snapshots the old settings editor saved are dropped.
    const theme = rows.find(row => row.id === 'ui-theme' && row.name === '@deepseek-ai/dsh-client-ui-theme')
    if (theme?.config && ('themes' in theme.config || 'external' in theme.config
        || productThemes.some(product => product.id === theme.config.preference))) {
      const saved = productThemes.find(product => product.id === theme.config.preference)
      if (saved) {
        let choice = rows.find(row => row.id === 'heron-ai-theme-preference')
        if (!choice) rows.push(choice = { id: 'heron-ai-theme-preference', name: entries.get('heron-ai-theme-preference').name, config: {} })
        choice.config = { ...choice.config, theme: saved.id, followHost: false }
        theme.config.preference = 'system'
      }
      delete theme.config.themes
      delete theme.config.external
      changed = true
    }
    for (const row of rows) {
      const entry = entries.get(row.id)
      if (!entry?.suffix || typeof row.name !== 'string' || !row.name.startsWith(generated)
        || !row.name.endsWith('/node_modules/@heron-ai/dsh-heron-ai' + entry.suffix)) continue
      row.name = entry.name
      changed = true
    }
    if (!changed) return
    const hash = createHash('sha256').update(text).digest('hex')
    try { await fs.writeFile(file + '.heron-ai-rc-' + hash + '.bak', text, { flag: 'wx', mode: 0o600 }) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    await writeFileAtomic(file, yaml.dump(rows, { schema: entryListSchema, noRefs: true, lineWidth: -1 }), { mode: 0o600 })
  }, { waitMs: 30000 })
}

export async function prepareRcSettings(options) {
  await fs.mkdir(options.home, { recursive: true })
  const file = path.join(options.home, 'settings.yaml')
  await withFileLock(file, async () => {
    let text
    try { text = await fs.readFile(file, 'utf8') }
    catch (error) { if (error.code === 'ENOENT') return; throw error }
    const settings = yaml.load(text)
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw Error('旧版设置格式无效，原文件已保留。')
    const old = settings['agent-presets']
    const oldModels = settings['llm-pi-ai']
    // Retired replacements stored preferences under their own row ids.
    const retiredNamespaces = [['common-agent-presets', 'agent-preset-registry'], ['heron-ai-settings-shell', 'ui-settings-general'], ['common-directory-picker', 'directory-picker'], ['heron-ai-model-settings', 'ui-settings-models'], ['heron-ai-deliverables', 'ui-deliverables'], ['heron-ai-chat', 'ui-chat'], ['heron-ai-session-controller', 'session-controller'], ['heron-ai-commands', 'ui-commands'], ['heron-ai-conversation', 'ui-conversation']]
      .filter(([retired]) => settings[retired] !== undefined)
    if (old === undefined && oldModels === undefined && !retiredNamespaces.length) return
    if (old !== undefined && (!old || typeof old !== 'object' || Array.isArray(old))) throw Error('旧版预设设置格式无效，原文件已保留。')
    const selectedDefault = old?.modeSelectionEnabled === false ? 'standard' : old?.default
    if (selectedDefault !== undefined && typeof selectedDefault !== 'string') throw Error('旧版默认预设格式无效，原文件已保留。')
    const hash = createHash('sha256').update(text).digest('hex')
    const backup = file + '.heron-ai-v0.1.6-alpha.1-' + hash + '.bak'
    try { await fs.writeFile(backup, text, { flag: 'wx', mode: 0o600 }) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    if (settings['agent-preset-registry'] === undefined && selectedDefault !== undefined)
      settings['agent-preset-registry'] = { selectedDefault }
    delete settings['agent-presets']
    for (const [retired, native] of retiredNamespaces) {
      settings[native] = { ...settings[native], ...settings[retired] }
      delete settings[retired]
    }
    if (oldModels !== undefined) {
      if (settings['heron-ai-llm-pi-ai'] === undefined) settings['heron-ai-llm-pi-ai'] = oldModels
      delete settings['llm-pi-ai']
    }
    await writeFileAtomic(file, yaml.dump(settings, { noRefs: true, lineWidth: -1 }), { mode: 0o600 })
  }, { waitMs: 30000 })
}
