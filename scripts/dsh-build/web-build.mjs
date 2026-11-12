// Run the shell's own Vite and retain its resolved inputs for the product cache.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [directory, reportFile] = process.argv.slice(2)
if (!directory || !reportFile) throw Error('Usage: web-build.mjs <web-directory> <input-report>')
const require = createRequire(path.join(directory, 'package.json'))
const project = fileURLToPath(new URL('../../', import.meta.url))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const watched = new Set([require.resolve('vite/package.json'), path.resolve(directory, '../../pnpm-lock.yaml')])
function inputCollector() {
  return {
    name: 'heron-ai-web-cache-inputs',
    configResolved(config) {
      for (const file of config.configFileDependencies) watched.add(file)
    },
    generateBundle() {
      for (const file of this.getWatchFiles()) watched.add(file)
    },
  }
}
const collector = inputCollector()
collector.config = config => {
  const workerPlugins = config.worker?.plugins
  return { worker: { plugins: () => [...workerPlugins?.() ?? [], inputCollector()] } }
}
await build({ root: directory, plugins: [collector] })

const inputs = new Set()
for (const id of watched) {
  if (id.includes('\0')) continue
  const file = path.resolve(directory, id.split('?')[0])
  try {
    if ((await fs.stat(file)).isFile()) inputs.add(await fs.realpath(file))
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
  }
}
// Export/resolution changes also invalidate the graph, even if the old entry's bytes stay the same.
const checked = new Set()
for (const file of [...inputs]) {
  for (let parent = path.dirname(file); !checked.has(parent); parent = path.dirname(parent)) {
    const relative = path.relative(project, parent)
    if (relative.startsWith('..') || path.isAbsolute(relative)) break
    checked.add(parent)
    const manifest = path.join(parent, 'package.json')
    try {
      await fs.access(manifest)
      inputs.add(manifest)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (path.dirname(parent) === parent) break
  }
}
await fs.writeFile(reportFile, JSON.stringify([...inputs].sort()) + '\n')
