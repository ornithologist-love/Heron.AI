import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { sourceInputs } from './build-receipt.mjs'
import { pluginBundleInputs, bundleFileIncluded } from './plugin-bundles.mjs'
import { readMcpBuildInputs } from './mcp-build-inputs.mjs'

export function payloadInputs(root) {
  const files = sourceInputs(root, ['LICENSE', 'THIRD-PARTY-NOTICES.md', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.pnpmfile.cjs', '.npmrc', 'node-runtime.json',
    'config', 'scripts', 'packages/common'])
  const dsh = path.join(root, 'packages/dsh')
  const repositories = new Map([[dsh, ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'apps/web']]])
  const forks = JSON.parse(fs.readFileSync(path.join(root, 'scripts/dsh-build/forks.json'), 'utf8'))
  for (const fork of forks) {
    if (fork.owner === 'heron-ai') continue
    const repository = path.resolve(dsh, fork.repository ?? '.')
    const directories = repositories.get(repository) ?? []
    directories.push(fork.packagePath ?? `packages/client/${fork.directory}`)
    repositories.set(repository, directories)
  }
  for (const [repository, directories] of repositories) files.push(...sourceInputs(repository, directories))
  return files
}

function bundledInputs(directory, root = directory, manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))) {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', '__pycache__'].includes(entry.name) || entry.name.endsWith('.pyc')) continue
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw Error('Bundled component contains a link')
    if (!bundleFileIncluded(manifest, path.relative(root, file), entry.isDirectory())) continue
    if (entry.isDirectory()) files.push(...bundledInputs(file, root, manifest))
    else if (entry.isFile()) files.push(file)
  }
  return files
}

// Release graphs use only this digest; private MCP values never leave this process.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const args = process.argv.slice(2)
  const manifest = args[0] === '--bundle-manifest' ? args[1] : undefined
  if (args[0] === '--bundle-manifest' && (!manifest || args.length !== 2)) throw Error('Expected --bundle-manifest <composition.json>')
  const bundle = pluginBundleInputs(manifest, manifest ? [] : args)
  const plugins = bundle.directories
  const mcp = readMcpBuildInputs(plugins, bundle.mcpSecretsFile)
  const files = [...payloadInputs(root), ...sourceInputs(root, ['tools/release'])]
  files.push(...bundle.manifestFiles, ...mcp.files)
  for (const plugin of plugins) {
    files.push(...bundledInputs(plugin))
  }
  const hash = createHash('sha256').update(process.version + ':' + process.platform + ':' + process.arch)
  for (const file of [...new Set(files)].sort()) hash.update(file).update('\0').update(fs.readFileSync(file)).update('\0')
  for (const [variable, token] of [...mcp.tokens].sort(([a], [b]) => a.localeCompare(b)))
    hash.update(variable).update('\0').update(token).update('\0')
  console.log(hash.digest('hex'))
}
