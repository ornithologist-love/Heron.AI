import { writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { AGENT_PLUGIN_EXPORT_FORMATS, exportAgentPlugin } from './export.mjs'
import { readAgentPluginManifest } from './manifest.mjs'
import { agentPluginSources, agentPluginStatePath, readAgentPluginState } from './sources.mjs'

const usage = [
  'Usage: node <AiHost>/main.mjs agent-plugin export <id> --output <file.zip> [--state-dir <directory>] [--format <target>]',
  '       node <AiHost>/main.mjs agent-plugin export --directory <plugin-folder> --output <file.zip> [--format <target>]',
  'Formats: ' + AGENT_PLUGIN_EXPORT_FORMATS.join(', ') + ' (default: standard).',
].join('\n')

async function findAgentPlugin(id, options) {
  const state = await readAgentPluginState(agentPluginStatePath(options.home))
  for (const source of await agentPluginSources(options, state)) {
    const plugin = await readAgentPluginManifest(source.directory, source).catch(() => undefined)
    if (plugin?.manifest.name !== id) continue
    if (!source.bundled && Object.hasOwn(state.plugins, id) && state.plugins[id]?.removed) continue
    return { directory: plugin.root, bundled: source.bundled }
  }
  throw Error('Installed Agent Plugin not found.')
}

export async function runAgentPluginCommand(argv, hostRoot) {
  const [action, ...args] = argv
  if (action === undefined || action === '--help') {
    process.stdout.write(usage + '\n')
    return
  }
  if (action !== 'export') throw Error(usage)
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      directory: { type: 'string' },
      format: { type: 'string', default: 'standard' },
      output: { type: 'string' },
      'state-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) {
    process.stdout.write(usage + '\n')
    return
  }
  if (positionals.length !== (values.directory ? 0 : 1)
    || !values.output || path.extname(values.output).toLowerCase() !== '.zip'
    || !AGENT_PLUGIN_EXPORT_FORMATS.includes(values.format)) throw Error(usage)
  const stateDir = path.resolve(values['state-dir'] ?? path.join(os.homedir(), '.heron-ai'))
  const source = values.directory ? { directory: path.resolve(values.directory), bundled: false }
    : await findAgentPlugin(positionals[0], { home: path.join(stateDir, 'dsh'), hostRoot })
  const { bytes } = await exportAgentPlugin(source.directory, {
    format: values.format, bundled: source.bundled, hostRoot,
  })
  const output = path.resolve(values.output)
  await writeFile(output, bytes, { flag: 'wx', mode: 0o600 }).catch(error => {
    if (error.code === 'EEXIST') throw Error('The output ZIP already exists.')
    if (error.code === 'ENOENT') throw Error('The ZIP output directory does not exist.')
    throw Error('Could not write the output ZIP.')
  })
  process.stdout.write(output + '\n')
}
