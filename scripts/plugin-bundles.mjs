import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { bundleFileIncluded } from '../packages/common/runtime/src/heron-ai/package-files.mjs'

export { bundleFileIncluded }

// Composition is an explicit build input owned by the distributor, outside the
// public product. A plain build never discovers sibling repositories.
export function pluginBundleInputs(manifestFile, directories = []) {
  const manifestFiles = new Set()
  let mcpSecretsFile
  if (manifestFile && directories.length) throw Error('Choose --bundle-manifest or --bundle-plugin, not both')
  if (manifestFile) {
    const active = new Set()
    const read = file => {
      file = path.resolve(file)
      if (active.has(file) || active.size >= 8) throw Error('Plugin composition inheritance cycle or excessive depth')
      active.add(file); manifestFiles.add(file)
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
      if (manifest.version !== 1 || !Array.isArray(manifest.plugins)
        || manifest.plugins.some(entry => typeof entry !== 'string' || !entry.trim())
        || manifest.extends !== undefined && (typeof manifest.extends !== 'string' || !manifest.extends.trim())
        || manifest.build !== undefined && (!manifest.build || typeof manifest.build !== 'object' || Array.isArray(manifest.build))
        || manifest.build?.mcpSecretsFile !== undefined && (typeof manifest.build.mcpSecretsFile !== 'string' || !manifest.build.mcpSecretsFile.trim()))
        throw Error('Invalid plugin composition manifest: ' + file)
      const inherited = manifest.extends ? read(path.resolve(path.dirname(file), manifest.extends)) : []
      if (manifest.build?.mcpSecretsFile !== undefined) {
        const filename = manifest.build.mcpSecretsFile
        mcpSecretsFile = filename.startsWith('~/')
          ? path.resolve(homedir(), filename.slice(2))
          : path.resolve(path.dirname(file), filename)
      }
      active.delete(file)
      return [...inherited, ...manifest.plugins.map(entry => path.resolve(path.dirname(file), entry))]
    }
    directories = read(manifestFile)
  }
  const resolved = directories.map(directory => path.resolve(directory))
  const names = new Set()
  for (const directory of resolved) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
    if (!manifest.name || !manifest.dsh?.bundle?.patch) throw Error('Not a DSH bundle: ' + directory)
    const required = [manifest.main, manifest.dsh.bundle.patch, manifest.heronAi?.integration,
      ...Object.values(manifest.heronAi?.entrypoints ?? {}), ...Object.values(manifest.heronAi?.hostProfiles ?? {}).map(profile => profile.entry),
      ...Object.values(manifest.heronAi?.content ?? {}), ...manifest.heronAi?.build?.requiredFiles ?? []].filter(value => value !== undefined)
    for (const relative of required) {
      if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)
        || relative.split(/[\\/]/).includes('..')) throw Error('Invalid required bundle input: ' + manifest.name)
      if (!fs.statSync(path.join(directory, relative), { throwIfNoEntry: false })?.isFile())
        throw Error('Missing required bundle input: ' + manifest.name + '/' + relative)
      if (!bundleFileIncluded(manifest, path.relative(directory, path.resolve(directory, relative))))
        throw Error('Required bundle input is excluded by files: ' + manifest.name + '/' + relative)
    }
    if (names.has(manifest.name)) throw Error('Duplicate bundled plugin: ' + manifest.name)
    names.add(manifest.name)
  }
  return { directories: resolved, manifestFiles, mcpSecretsFile }
}
