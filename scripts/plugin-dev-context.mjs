// Build-time developer context. Runtime startup never imports or scans this data.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

const bundlePath = 'heron-ai/ui/widgets.js'
const mapPath = bundlePath + '.map'
const manifestPath = 'plugin-dev-context.json'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'))

function authoredSources(map) {
  if (map.version !== 3 || map.file !== 'widgets.js' || typeof map.mappings !== 'string' || !map.mappings
      || !Array.isArray(map.sources) || !Array.isArray(map.sourcesContent)
      || map.sources.length !== map.sourcesContent.length || !map.sources.length
      || map.sources.some(source => typeof source !== 'string')
      || map.sourcesContent.some(source => typeof source !== 'string'))
    throw Error('Plugin UI context requires a self-contained Source Map v3 with sourcesContent')
  const sources = map.sources.flatMap((source, index) => {
    const normalized = source.replaceAll('\\', '/')
    const prefix = 'common/ui/src/'
    const start = normalized.indexOf(prefix)
    // Query-suffixed Vite modules contain transformed code, not original files.
    if (start < 0 || normalized.includes('?')) return []
    const relative = normalized.slice(start + prefix.length)
    if (!relative || relative.split('/').some(part => part === '..' || part === '.') || path.isAbsolute(relative))
      throw Error('Invalid authored UI source path')
    return [{ path: 'src/' + relative, index, sha256: digest(map.sourcesContent[index]) }]
  })
  if (!sources.some(source => source.path === 'src/DshProviderSettings.vue'))
    throw Error('Plugin UI context lost original Vue implementation; an identity fallback is insufficient')
  return sources
}

async function identity(hostRoot) {
  const product = await readJson(path.join(hostRoot, 'package.json'))
  const dsh = await readJson(path.join(hostRoot, 'node_modules/@deepseek-ai/dsh/package.json'))
  return { product: product.name, version: product.version, dshVersion: dsh.version,
    forksSha256: digest(await fs.readFile(path.join(hostRoot, 'node_modules/.heron-ai-dsh-forks.json'))) }
}

export async function writeDevelopmentContext(hostRoot, uiSourceRoot) {
  const mapBytes = await fs.readFile(path.join(hostRoot, mapPath))
  const map = JSON.parse(mapBytes)
  const manifest = { schemaVersion: 1, ...await identity(hostRoot), ui: {
    bundle: bundlePath, bundleSha256: digest(await fs.readFile(path.join(hostRoot, bundlePath))),
    sourceMap: mapPath, sourceMapSha256: digest(mapBytes),
    sourceCount: map.sources?.length, authoredSources: authoredSources(map),
  } }
  await fs.writeFile(path.join(hostRoot, manifestPath), JSON.stringify(manifest, null, 2) + '\n')
  await verifyDevelopmentContext(hostRoot, uiSourceRoot)
}

export async function verifyDevelopmentContext(hostRoot, uiSourceRoot) {
  const manifest = await readJson(path.join(hostRoot, manifestPath))
  const actual = await identity(hostRoot)
  if (manifest.schemaVersion !== 1 || Object.entries(actual).some(([key, value]) => manifest[key] !== value)
      || manifest.ui?.bundle !== bundlePath || manifest.ui?.sourceMap !== mapPath)
    throw Error('Plugin developer context does not match this payload version and fork')
  const bundle = await fs.readFile(path.join(hostRoot, bundlePath))
  const mapBytes = await fs.readFile(path.join(hostRoot, mapPath))
  if (digest(bundle) !== manifest.ui.bundleSha256 || digest(mapBytes) !== manifest.ui.sourceMapSha256)
    throw Error('Plugin developer context artifact hash mismatch')
  if (/sourceMappingURL\s*=/.test(bundle.toString('utf8')))
    throw Error('Plugin UI map must be hidden: the homepage must not auto-request developer context')
  const map = JSON.parse(mapBytes)
  const sources = authoredSources(map)
  if (map.sources.length !== manifest.ui.sourceCount || JSON.stringify(sources) !== JSON.stringify(manifest.ui.authoredSources))
    throw Error('Plugin developer context source index mismatch')
  if (uiSourceRoot) for (const source of sources) {
    const original = await fs.readFile(path.join(uiSourceRoot, source.path.slice('src/'.length)))
    if (digest(original) !== source.sha256) throw Error('Plugin UI source is stale: ' + source.path)
  }
  return { authoredSources: sources.length, embeddedSources: map.sources.length }
}
