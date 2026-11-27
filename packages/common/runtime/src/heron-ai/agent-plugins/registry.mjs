import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { saveJson } from '../migration/files.mjs'
import { readAgentPlugin, readAgentSkill } from './manifest.mjs'
import { exportAgentPlugin } from './export.mjs'
import { AgentPluginImportError } from './import-files.mjs'
import { createAgentPluginImporter } from './import-manager.mjs'
import { agentPluginSources, agentPluginStatePath, readAgentPluginState } from './sources.mjs'

// On Windows the stdio child can hold its working directory briefly after disconnect.
async function retireDirectory(source, target) {
  for (let retry = 0; ; retry++) {
    try {
      await fs.rename(source, target)
      return
    } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error
      if (retry >= 30) throw new AgentPluginImportError('插件目录仍被占用，稍后可重新移除。')
      await delay(100)
    }
  }
}

export function agentServerName(plugin, key) {
  const prefix = plugin.slice(0, 17).replaceAll('.', '-')
  const hash = createHash('sha256').update(`${plugin}:${key}`).digest('hex').slice(0, 14)
  return `${prefix}-${hash}`
}

const BUNDLED_FEATURE_SKILL_RANK = 250

function mountSkills(ctx, plugin) {
  const bundledFeature = Boolean(plugin.bundled && plugin.skillProviderName)
  const name = bundledFeature ? plugin.skillProviderName : `agent-plugin-${plugin.name}`
  const rank = bundledFeature ? BUNDLED_FEATURE_SKILL_RANK : BUNDLED_SKILL_RANK
  return ctx.skills.registerProvider(control => ({
    name,
    async list() {
      return plugin.skills.map(skill => ({
        name: skill.name, description: skill.description, path: skill.entryPath,
        provider: name, source: plugin.bundled ? 'bundled' : 'agent-plugin', rank,
        invocation: skill.invocation, whenToUse: skill.whenToUse, metadata: skill.metadata,
        resourceBase: { kind: 'directory', path: skill.root }, locator: skill,
      }))
    },
    async get(candidate, { signal }) {
      signal?.throwIfAborted()
      control.signal.throwIfAborted()
      const skill = await readAgentSkill(plugin.root, candidate.locator)
      signal?.throwIfAborted()
      control.signal.throwIfAborted()
      if (!skill || skill.name !== candidate.name) return undefined
      const { rank, locator, ...summary } = candidate
      return { ...summary, description: skill.description, whenToUse: skill.whenToUse,
        invocation: skill.invocation, metadata: skill.metadata, content: skill.content }
    },
  }))
}

export async function createAgentPluginRegistry(ctx, options, onChange) {
  const statePath = agentPluginStatePath(options.home)
  const installRoot = path.join(options.home, 'agent-plugins')
  const dataDirectory = name => path.join(options.home, 'agent-plugin-data', name)
  const readPlugin = (directory, bundled = false) => readAgentPlugin(directory, dataDirectory, {
    bundled,
    onDiagnostic: message => ctx.logger.warn('Agent Plugin %s: %s', directory, message),
  })
  const mounted = new Map()
  let plugins = new Map()
  async function reconcile(state) {
    const next = new Map()
    const sources = await agentPluginSources(options, state)
    for (const { directory, bundled } of sources) {
      try {
        const plugin = await readPlugin(directory, bundled)
        const record = Object.hasOwn(state.plugins, plugin.name) ? state.plugins[plugin.name] : undefined
        if (!bundled && record?.removed) continue
        const existing = next.get(plugin.name)
        if (existing?.root === plugin.root) continue
        if (existing) throw Error(`Duplicate Agent Plugin name: ${plugin.name}`)
        next.set(plugin.name, { ...plugin, bundled, enabled: record?.enabled !== false })
      } catch (error) {
        ctx.logger.warn('Unable to load Agent Plugin %s: %s', directory, error.message)
      }
    }
    await onChange([...next.values()])
    for (const [id, current] of mounted) {
      const plugin = next.get(id)
      if (plugin?.enabled && current.signature === JSON.stringify(plugin.skills)) continue
      current.dispose()
      mounted.delete(id)
    }
    for (const [id, plugin] of next) {
      if (plugin.enabled && plugin.skills.length && !mounted.has(id)) {
        mounted.set(id, { signature: JSON.stringify(plugin.skills), dispose: mountSkills(ctx, plugin) })
      }
    }
    plugins = next
  }

  async function change(mutate) {
    await fs.mkdir(path.dirname(statePath), { recursive: true })
    await withFileLock(statePath, async () => {
      const previous = await readAgentPluginState(statePath)
      const state = { ...previous, plugins: { ...previous.plugins } }
      const transaction = await mutate(state.plugins)
      try {
        await saveJson(statePath, state)
        await reconcile(state)
        await transaction?.verify?.()
      } catch (error) {
        try { await transaction?.rollback() }
        finally {
          await saveJson(statePath, previous)
          await reconcile(previous)
        }
        throw error
      }
    }, { waitMs: 30_000 })
  }

  const importer = createAgentPluginImporter(ctx, options.home, async (directory, name) => {
    const target = path.join(installRoot, name)
    await change(async records => {
      if (plugins.has(name) || (Object.hasOwn(records, name) && records[name]?.directory && !records[name].removed)) {
        throw new AgentPluginImportError('已安装同名 Agent Plugin。')
      }
      await fs.mkdir(installRoot, { recursive: true })
      if (!(await fs.lstat(installRoot)).isDirectory()) throw new AgentPluginImportError('插件安装目录必须是普通文件夹。')
      const existing = await fs.lstat(target).catch(error => {
        if (error.code !== 'ENOENT') throw error
      })
      if (existing) throw new AgentPluginImportError('存在同名插件目录。')
      await fs.rename(directory, target)
      Object.defineProperty(records, name, {
        value: { enabled: true, managed: true }, enumerable: true, configurable: true, writable: true,
      })
      return {
        rollback: () => fs.rename(target, directory),
        verify: async () => {
          if (plugins.get(name)?.root !== await fs.realpath(target)) throw new AgentPluginImportError('已取消安装，插件校验未通过。')
        },
      }
    })
  }, { homeDir: options.homeDir })

  ctx.effect(() => () => { for (const { dispose } of mounted.values()) dispose() })
  await reconcile(await readAgentPluginState(statePath))
  return {
    list: () => [...plugins.values()].map(plugin => ({
      id: plugin.name, name: plugin.title, description: plugin.description, icon: plugin.icon,
      enabled: plugin.enabled, imported: !plugin.bundled,
      connectorIds: plugin.cards.length ? plugin.cards.map(card => card.id) : [plugin.name],
      skills: plugin.skills.map(({ name, description }) => ({ name, description })),
    })),
    async export(id, format) {
      const plugin = plugins.get(id)
      if (!plugin) return undefined
      return exportAgentPlugin(plugin.root, { format, bundled: plugin.bundled, hostRoot: options.hostRoot })
    },
    ...importer,
    async setEnabled(id, enabled) {
      await change(records => {
        if (!plugins.has(id)) throw Error('Agent Plugin not found')
        Object.defineProperty(records, id, {
          value: { ...Object.getOwnPropertyDescriptor(records, id)?.value, enabled },
          enumerable: true, configurable: true, writable: true,
        })
      })
    },
    async remove(id, afterUnmount) {
      let staging, moved = false
      try {
        await change(async records => {
          const plugin = plugins.get(id)
          if (!plugin || plugin.bundled) throw Error('Only local Agent Plugins can be removed')
          const record = Object.getOwnPropertyDescriptor(records, id)?.value
          Object.defineProperty(records, id, {
            value: { removed: true }, enumerable: true, configurable: true, writable: true,
          })
          if (!record?.managed) return
          const target = path.join(installRoot, id)
          if (plugin.root !== await fs.realpath(target)) throw Error('Agent Plugin install directory changed')
          staging = await fs.mkdtemp(path.join(options.home, '.agent-plugin-remove-'))
          const removed = path.join(staging, 'package')
          return {
            verify: async () => {
              await afterUnmount?.()
              await retireDirectory(target, removed)
              moved = true
            },
            rollback: async () => {
              if (moved) await fs.rename(removed, target)
              moved = false
            },
          }
        })
        moved = false
      } finally {
        if (staging && !moved) await fs.rm(staging, { recursive: true, force: true })
      }
    },
  }
}
