import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { enabledProductPackages, initializeProductContent } from './product-profile.mjs'

export function resolveExtensionEntrypoint(name) {
  const matches = []
  for (const { root, manifest } of enabledProductPackages.values()) {
    const relative = manifest.heronAi?.entrypoints?.[name]
    if (relative === undefined) continue
    if (typeof relative !== 'string') throw Error('Invalid extension entrypoint: ' + name)
    const file = path.resolve(root, relative), below = path.relative(root, file)
    if (!below || below.startsWith('..') || path.isAbsolute(below)) throw Error('Extension entrypoint must stay inside its package')
    matches.push(file)
  }
  if (matches.length !== 1) throw Error(matches.length ? 'Conflicting extension entrypoint: ' + name : 'Required extension is not installed or enabled: ' + name)
  return matches[0]
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [name, flag, stateDir, ...args] = process.argv.slice(2)
    if (!name || flag !== '--state-dir' || !path.isAbsolute(stateDir ?? '')) throw Error('Usage: entrypoints.mjs <name> --state-dir <directory> [arguments...]')
    process.env.HERON_AI_RUNTIME_ROOT = fileURLToPath(new URL('../', import.meta.url))
    await import('./extension-loader.mjs')
    initializeProductContent({ stateDir })
    const entry = resolveExtensionEntrypoint(name)
    process.argv = [process.execPath, entry, ...args]
    await import(pathToFileURL(entry).href)
  } catch (error) {
    process.stderr.write(String(error.message).replace(/[\r\n]/g, ' ') + '\n')
    process.exitCode = 1
  }
}
