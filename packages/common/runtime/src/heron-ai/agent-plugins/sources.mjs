import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { readJson } from '../migration/files.mjs'

export const agentPluginStatePath = home => path.join(home, 'profiles', 'web', 'agent-plugins.json')

export async function readAgentPluginState(statePath) {
  const value = await readJson(statePath) ?? { version: 1, plugins: {} }
  if (value.version !== 1 || !value.plugins || typeof value.plugins !== 'object' || Array.isArray(value.plugins)) {
    throw Error('Invalid Agent Plugin profile state')
  }
  return value
}

async function pluginDirectories(directory) {
  try {
    const folders = await readdir(directory, { withFileTypes: true })
    return folders.filter(folder => folder.isDirectory()).map(folder => path.join(directory, folder.name)).sort()
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

/** The installed source order is bundled, conventionally discovered, then explicitly imported. */
export async function agentPluginSources({ home, hostRoot }, state) {
  const bundled = await pluginDirectories(path.join(hostRoot, 'heron-ai', 'content', 'agent-plugins'))
  const local = await pluginDirectories(path.join(home, 'agent-plugins'))
  return [
    ...bundled.map(directory => ({ directory, bundled: true })),
    ...local.map(directory => ({ directory, bundled: false })),
    ...Object.values(state.plugins).filter(record => record.directory && !record.removed)
      .map(record => ({ directory: record.directory, bundled: false })),
  ]
}
