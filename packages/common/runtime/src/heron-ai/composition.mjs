import { legacyPresetAliases, legacyPresetPrefixes } from './migration/branding.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { ai_provider_definitions } from './acp/runtime/providers.mjs'
import { bundledDirectory } from './acp/runtime/provider-directory.mjs'
import { userSkillRoots } from './runtime/skill-roots.mjs'
import os from 'node:os'
import { backendPreset, delegatedModelRoutes } from './acp/providers.mjs'
import { cachedComposition } from './composition-cache.mjs'
import { composeIntegrations } from './integrations.mjs'
import yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

// Skill roots of other agent tools in the user's home, listed in 技能管理 under their tool's name.
const homeSkillRoots = [
  { provider: 'heron-ai-home-agents', folder: '.agents', label: 'Agents' },
  { provider: 'heron-ai-home-claude', folder: '.claude', label: 'Claude Code' },
  { provider: 'heron-ai-home-codex', folder: '.codex', label: 'Codex' },
]

// HeronAI owns product inputs and its own plugin composition.
// The standard payload build assembles third-party source forks.
export async function prepareComposition(config) {
  return cachedComposition(config, buildComposition)
}

async function buildComposition(config, extensions) {
  const pluginRoot = path.join(config.hostRoot, 'heron-ai')
  const manifest = JSON.parse(await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8'))
  const local = path.join(extensions, 'node_modules', manifest.name)
  await fs.mkdir(local, { recursive: true })
  await fs.writeFile(path.join(local, 'package.json'), JSON.stringify(manifest, null, 2))
  for (const id of ['navigation', 'theme-preference', 'model-preferences']) {
    await fs.mkdir(path.join(local, 'settings'), { recursive: true })
    await fs.writeFile(path.join(local, 'settings', id + '.mjs'), `export * from ${JSON.stringify(pathToFileURL(path.join(pluginRoot, 'settings', id + '.mjs')).href)};\n`)
  }
  for (const file of ['native-models', 'default-model', 'web', 'theme-palettes', 'context'])
    await fs.writeFile(path.join(local, file + '.mjs'), `export * from ${JSON.stringify(pathToFileURL(path.join(pluginRoot, file + '.mjs')).href)};\n`)
  await fs.writeFile(path.join(local, 'preset-base.mjs'), `export { default } from ${JSON.stringify(pathToFileURL(path.join(pluginRoot, 'preset-base.mjs')).href)};\n`)
  const entry = pathToFileURL(path.join(pluginRoot, 'index.mjs')).href
  await fs.writeFile(path.join(local, 'index.mjs'), `export * from ${JSON.stringify(entry)};\n`)
  const require = createRequire(path.join(config.hostRoot, 'package.json'))
  const heronAi = await composeIntegrations(config)
  // Aspects may add brand marks for their model channels; a colored mark renders as an image, not a mask.
  const brands = heronAi.brands ?? []
  const icons = {}
  for (const [id, file, mime] of [['heronAi', 'runtime-logo.svg', 'image/svg+xml'],
    ...['claude', 'deepseek', 'google', 'minimax', 'kimi', 'openai', 'hunyuan', 'zhipuai', 'xiaomi']
      .map(id => [id, `model-logos/${id}.svg`, 'image/svg+xml'])]) {
    const asset = id === 'heronAi' && config.brandLogo ? config.brandLogo : path.join(pluginRoot, 'assets', file)
    const type = id === 'heronAi' && path.extname(asset).toLowerCase() === '.png' ? 'image/png' : mime
    icons[id] = `data:${type};base64,${(await fs.readFile(asset)).toString('base64')}`
  }
  for (const brand of brands) icons[brand.id] = `data:${brand.mime};base64,${(await fs.readFile(brand.file)).toString('base64')}`
  const client = await fs.readFile(path.join(config.hostRoot, 'heron-ai', 'client.js'), 'utf8')
  // The marks fill their artboards unevenly (OpenAI/GLM ~75%, Claude 100%), so each gets its own scale to land at
  // ~12.5px in a 16px box, so provider headings and model rows read at one size.
  const brandScales = { claude: 0.78, deepseek: 1, google: 0.92, minimax: 0.78, kimi: 0.88, openai: 1, hunyuan: 0.75,
    zhipuai: 1, xiaomi: 0.82, heronAi: 0.9 }
  for (const brand of brands) brandScales[brand.id] = brand.scale
  const modelIcons = Object.fromEntries(['claude', 'deepseek', 'google', 'minimax', 'kimi', 'openai', 'hunyuan', 'zhipuai', 'xiaomi']
    .map(id => [id, { src: icons[id], monochrome: true, scale: brandScales[id] }]))
  for (const brand of brands) modelIcons[brand.id] = { src: icons[brand.id], monochrome: !brand.colored, scale: brand.scale }
  modelIcons.heronAi = { src: icons.heronAi, monochrome: false, scale: brandScales.heronAi }
  modelIcons['deepseek-official'] = modelIcons.deepseek
  modelIcons['deepseek-account'] = modelIcons.deepseek
  const credentialHelp = { 'deepseek-official': { url: 'https://platform.deepseek.com/api_keys', label: 'DeepSeek API Keys' } }
  for (const [id, row] of Object.entries(bundledDirectory.providers))
    if (row.credential?.help_url) credentialHelp[id] = { url: row.credential.help_url, label: row.credential.help_label ?? row.name }
  await fs.writeFile(path.join(local, 'client.js'), client.replace('/* HERON_AI_BRAND_ASSETS */ {}', JSON.stringify(icons))
    .replace('/* HERON_AI_CREDENTIAL_HELP */ {}', JSON.stringify(credentialHelp))
    .replace('/* HERON_AI_CREDENTIAL_POLICY */ {}', JSON.stringify(heronAi.credentialPolicy ?? {}))
    .replace('/* HERON_AI_PROVIDER_NOTICES */ []', JSON.stringify(heronAi.providerNotices ?? []))
    .replace('/* HERON_AI_PROVIDER_SIGN_IN */ {}', JSON.stringify(heronAi.providerSignIn ?? {}))
    .replace('/* HERON_AI_COLORED_BRANDS */ []', JSON.stringify(['heronAi', ...brands.filter(brand => brand.colored).map(brand => brand.id)]))
    .replace('/* HERON_AI_BRAND_SCALES */ {}', JSON.stringify(brandScales)).replace('/* HERON_AI_WORKSPACES */',
    await fs.readFile(path.join(pluginRoot, 'workspaces/client.js'), 'utf8')).replace('/* HERON_AI_THEMES */',
    await fs.readFile(path.join(pluginRoot, 'themes/client.js'), 'utf8')))

  const productPlugins = new Set()
  for (const source of heronAi.clientPackages) {
    const plugin = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'))
    if (productPlugins.has(plugin.name)) throw Error('Duplicate contributed client package: ' + plugin.name)
    const target = path.join(extensions, 'node_modules', plugin.name)
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(path.join(target, 'package.json'), JSON.stringify(plugin, null, 2))
    await fs.writeFile(path.join(target, 'index.mjs'), `export * from ${JSON.stringify(pathToFileURL(path.join(source, 'index.mjs')).href)};\n`)
    await fs.copyFile(path.join(source, 'client.js'), path.join(target, 'client.js'))
    productPlugins.add(plugin.name)
  }

  const standardPatch = yaml.load(await fs.readFile(require.resolve('@deepseek-ai/dsh-web-app/presets/standard.patch.yml'), 'utf8'), { schema: entryListSchema })
  const standard = standardPatch.flatMap(row => row.insert ?? []).find(row => row.config?.id === 'standard')?.config.plugins
  if (!Array.isArray(standard)) throw Error('Pinned DSH standard preset definition is missing')
  // UE workspaces hold large generated trees; searches skip them unless the model asks for search_scope=all.
  for (const plugin of standard) {
    if (plugin.name === '@deepseek-ai/dsh-tool-fs-search') {
      plugin.config = { ...plugin.config, projectScope: { excludedDirectories: ['Saved', 'Intermediate', 'Binaries', 'DerivedDataCache', 'node_modules'] } }
    }
  }
  const presets = ai_provider_definitions.map(provider => ({
    id: 'preset-' + backendPreset(provider.id), name: '@deepseek-ai/dsh-agent-preset',
    config: { id: backendPreset(provider.id), name: provider.name,
      description: `DSH 原生 Agent，使用 ${provider.name} 模型。`,
      order: 10, plugins: standard },
  }))
  // The host package supplies host rows, brand and external theme; without
  // one (standalone App) the product uses its neutral presentation.
  const host = config.hostPackage
    ? await (await import(config.hostPackage)).compose(config, { logo: icons.heronAi })
    : { rows: [], brand: undefined, externalTheme: undefined }
  const brand = host.brand ?? { enabled: config.branding, label: 'Heron.AI', logo: icons.heronAi, monochrome: false,
    title: 'Heron.AI', subtitle: '', harnessMark: true, tokens: null, language: null }
  // A host brand may name the wording its users start with; the profile itself stays presentation.
  const { defaultLocale: brandLocale = 'zh', ...brandProfile } = brand

  const rows = [
    { id: 'heron-ai-provider-web', name: manifest.name + '/web', config: { searchProvider: 'deepseek-official', fetchProvider: 'http' } },
    { id: 'heron-ai-client-modules', name: '@deepseek-ai/dsh-client-modules', config: { sourceMaps: false } },
    { id: 'heron-ai-theme-palettes', name: manifest.name + '/theme-palettes', config: {
      enabled: config.heronAiThemes !== false, external: host.externalTheme ?? null,
    } },
    { id: 'heron-ai', name: manifest.name, config },
    { id: 'common-image-viewer', name: '@common/image-viewer' },
    { id: 'common-context', name: manifest.name + '/context', config: {
      text: '你是 Heron.AI，使用当前模型与已接入的工具帮助用户完成任务。项目背景和生产规范以当前工作区的 Skills 与资料为准；连接状态与可用能力以当前宿主信息和实际工具为准。',
    } },
    { id: 'common-toolbar', name: '@common/toolbar' },
    { id: 'common-capabilities', name: '@common/capabilities' },
    { id: 'common-preset-base', name: manifest.name + '/preset-base', config: {
      standard, delegatedModels: delegatedModelRoutes(config.providerCatalogSnapshot ?? {}) } },
    { id: 'better-sidebar', name: 'dsh-better-sidebar' },
    // 个人待办：右侧栏标签，数据按实例保存在 <stateDir>/dsh/todo-list。
    { id: 'todo-list', name: '@common/todo-list', config: { stateDir: config.stateDir } },
    { id: 'common-brand', name: '@common/brand', config: {
      profile: { ...brandProfile, enabled: config.branding && brand.enabled },
      defaultTheme: '', defaultLocale: brandLocale,
    } },
    ...heronAi.rows,
    ...host.rows,
    { id: 'heron-ai-llm-pi-ai', name: manifest.name + '/native-models' },
    { id: 'heron-ai-agent-presets', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'standard', hiddenPresetPrefixes: ['heron-ai-acp-', 'common-archive-', ...legacyPresetPrefixes], lockedPresetPrefixes: ['heron-ai-acp-', 'common-archive-', ...legacyPresetPrefixes] } },
    { id: 'heron-ai-standard-preset', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'standard', order: 1, plugins: standard } },
    { id: 'heron-ai-default-model-policy', name: manifest.name + '/default-model' },
    ...presets, ...legacyPresetAliases(presets),
    ...['navigation', 'theme-preference', 'model-preferences'].map(id => ({ id: 'heron-ai-' + id, name: manifest.name + '/settings/' + id })),
    { id: 'heron-ai-session-controller', name: '@deepseek-ai/dsh-api-session-controller' },
    { id: 'heron-ai-conversation', name: '@deepseek-ai/dsh-client-ui-conversation', config: { showHeroText: !config.branding, unboundWorkspaceLabel: '临时会话' } },
    { id: 'heron-ai-sidebar', name: '@deepseek-ai/dsh-client-ui-sidebar' },
    { id: 'heron-ai-skill-selection', name: '@deepseek-ai/dsh-client-ui-skill' },
    { id: 'heron-ai-permission-selection', name: '@deepseek-ai/dsh-client-ui-permission-presets', config: { rememberFullAccess: true, colors: { 'danger-full-access': '#eb8d55' } } },
    { id: 'heron-ai-preset-selection', name: '@deepseek-ai/dsh-client-ui-agent-preset', config: { hiddenAgentPresetPrefixes: ['heron-ai-acp-', 'common-archive-', ...legacyPresetPrefixes], seatRequiresDeveloperTools: true } },
    { id: 'heron-ai-mcp-manager', name: 'dsh-mcp-manager', config: { useIntegration: true } },
    { id: 'heron-ai-model-settings', name: '@deepseek-ai/dsh-client-ui-settings-models', config: { welcomeNotice: false, credentialOnboarding: false, credentialOnlyProviders: ai_provider_definitions.map(provider => provider.id),
      hiddenProviders: ai_provider_definitions.filter(provider => provider.public).map(provider => provider.id),
      providerEditorLayouts: { 'heron-ai-llm-pi-ai': 'pi-ai' },
      providerIcons: Object.fromEntries(['deepseek-official', 'deepseek-account', ...ai_provider_definitions.map(provider => provider.id)].map(id => [id, modelIcons[id]])) } },
    { id: 'heron-ai-skill-manager', name: 'dsh-skill-manager', config: { presetGroupLabels: [...heronAi.skillGroupLabels, { prefix: 'heron-ai-acp-', label: 'Runtime' }, { prefix: 'heron-ai-bundled', label: '内置' }, ...homeSkillRoots.map(({ provider, label }) => ({ prefix: provider, label }))] } },
    { id: 'heron-ai-skills', name: '@deepseek-ai/dsh-skill-filesystem', config: { providerName: 'heron-ai-bundled', includeDefaultRoots: false, bundledSkillDir: config.skillsDir,
      customSkillDirs: userSkillRoots(config.stateDir, false) } },
    // The user's own skills get one read-only provider per agent tool, so 技能管理 groups them by origin instead of as Heron.AI's.
    ...config.includeUserSkillRoots !== false ? homeSkillRoots.map(({ provider, folder }) => ({ id: provider + '-skills', name: '@deepseek-ai/dsh-skill-filesystem',
      config: { providerName: provider, includeDefaultRoots: false, customSkillDirs: [path.join(os.homedir(), folder, 'skills')] } })) : [],
  ]
  // Copies resolve against a cached dependency directory. Keep installed
  // packages read-only; link dependencies only after all overrides are written.
  const dependencyRoot = path.resolve(path.dirname(require.resolve('@deepseek-ai/dsh/package.json')), '..', '..')
  for (const entry of await fs.readdir(dependencyRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const source = path.join(dependencyRoot, entry.name)
    const target = path.join(extensions, 'node_modules', entry.name)
    if (entry.name.startsWith('@')) {
      await fs.mkdir(target, { recursive: true })
      for (const name of await fs.readdir(source)) {
        const destination = path.join(target, name)
        try { await fs.lstat(destination) } catch (error) {
          if (error.code !== 'ENOENT') throw error
          await fs.symlink(path.join(source, name), destination, 'junction')
        }
      }
    } else {
      try { await fs.lstat(target) } catch (error) {
        if (error.code !== 'ENOENT') throw error
        await fs.symlink(source, target, 'junction')
      }
    }
  }
  return rows
}
