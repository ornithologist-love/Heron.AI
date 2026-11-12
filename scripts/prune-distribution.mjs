// Assemble a product distribution from the build SDK; never edit that SDK or
// upstream source. Resolve the installed dependency graph before deleting files.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { excludedPackage, dependencyFields, omitExcludedDependencies } from '../packages/common/runtime/src/dsh/distribution.mjs'
import { distributionFileContext, discardDistributionFile } from './distribution-files.mjs'
import { recordAssemblyTransforms } from './dependencies.mjs'

const host = path.resolve(process.argv[2])
const modules = path.join(host,'node_modules')
const packages = new Map()
const read = file => fs.readFile(file,'utf8').then(JSON.parse)
async function inventory(directory) {
  for (const entry of await fs.readdir(directory,{ withFileTypes:true })) {
    if (entry.name.startsWith('.')) continue
    if (entry.isSymbolicLink()) throw Error('AI distribution cannot prune linked packages: ' + entry.name)
    if (!entry.isDirectory()) continue
    const location = path.join(directory,entry.name)
    if (entry.name.startsWith('@')) { await inventory(location); continue }
    const manifest = await read(path.join(location,'package.json'))
    packages.set(location,{ manifest,name:manifest.name,location })
    try { await inventory(path.join(location,'node_modules')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}
await inventory(modules)
const root = await read(path.join(host,'package.json'))
const require = createRequire(path.join(host,'package.json'))
const yaml = require('js-yaml')
const { entryListSchema } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-include')).href)
const keep = new Set(), queue = [{ location:host,manifest:root }]
function resolve(location,name) {
  for (let current = location; current.startsWith(host); current = path.dirname(current)) {
    const candidate = path.join(current,'node_modules',name)
    if (packages.has(candidate)) return candidate
    if (current === host) break
  }
}
for (let next = queue.shift(); next; next = queue.shift()) {
  for (const field of dependencyFields) for (const name of Object.keys(next.manifest[field] ?? {})) {
    if (excludedPackage(name)) continue
    const location = resolve(next.location,name)
    if (!location) {
      if (field === 'dependencies' && !next.manifest.optionalDependencies?.[name])
        throw Error(`AI distribution dependency is missing: ${next.manifest.name} -> ${name}`)
      continue
    }
    if (keep.has(location)) continue
    keep.add(location); queue.push(packages.get(location))
  }
}
const removed = [...packages.values()].filter(pkg => !keep.has(pkg.location))
const commands = pkg => typeof pkg.manifest.bin === 'string'
  ? [pkg.name.split('/').at(-1)] : Object.keys(pkg.manifest.bin ?? {})
const binDirectory = pkg => path.resolve(pkg.location,pkg.name.startsWith('@') ? '../..' : '..','.bin')
const keptCommands = new Set([...packages.values()].filter(pkg => keep.has(pkg.location))
  .flatMap(pkg => commands(pkg).map(command => path.join(binDirectory(pkg),command))))
for (const pkg of removed) for (const command of commands(pkg)) {
  const file = path.join(binDirectory(pkg),command)
  if (keptCommands.has(file)) continue
  if (!file.toLowerCase().startsWith((modules + path.sep).toLowerCase())) throw Error('Invalid AI command prune target')
  for (const suffix of ['','.cmd','.ps1'])
    await fs.unlink(file + suffix).catch(error => { if (error.code !== 'ENOENT') throw error })
}
// Every recursive deletion is an inventoried real directory under this exact
// assembled payload, never a path in the source SDK or user data.
const modulePrefix = (modules + path.sep).toLowerCase()
for (const pkg of removed) {
  if (!path.resolve(pkg.location).toLowerCase().startsWith(modulePrefix)) throw Error('Invalid AI prune target')
  await fs.rm(pkg.location,{ recursive:true,force:true })
}
for (const pkg of [{ location:host,manifest:root },...packages.values()].filter(pkg => pkg.location === host || keep.has(pkg.location))) {
  const before = JSON.stringify(pkg.manifest)
  omitExcludedDependencies(pkg.manifest)
  if (JSON.stringify(pkg.manifest) !== before)
    await fs.writeFile(path.join(pkg.location,'package.json'),JSON.stringify(pkg.manifest,null,2) + '\n')
}
// Bundle patches are product assembly data. Remove the registrations too,
// rather than leaving disabled/missing plugins in the UI or profile inventory.
const packageName = name => name.startsWith('@') ? name.split('/').slice(0,2).join('/') : name.split('/')[0]
function filterEntries(value) {
  if (Array.isArray(value)) return value.filter(item =>
    !(item && typeof item.name === 'string' && excludedPackage(packageName(item.name)))).map(filterEntries)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,filterEntries(item)]))
}
const compositionFiles = [
  '@deepseek-ai/dsh-base/cordis.patch.yml',
  '@deepseek-ai/dsh-web-app/cordis.patch.yml',
  '@deepseek-ai/dsh-web-app/presets/standard.patch.yml',
  '@deepseek-ai/dsh-sdk-app/cordis.patch.yml',
]
const transforms = new Map()
for (const relative of compositionFiles) {
  const file = path.join(modules,relative)
  const data = yaml.load(await fs.readFile(file,'utf8'),{ schema:entryListSchema })
  const filtered = filterEntries(data)
  if (JSON.stringify(filtered) !== JSON.stringify(data)) {
    const bytes = yaml.dump(filtered,{ schema:entryListSchema,lineWidth:-1,noRefs:true })
    await fs.writeFile(file,bytes)
    transforms.set(file,bytes)
  }
}
// Runtime locks describe the shipped graph; the source lock remains the
// reproducible, complete SDK input used by pnpm and the native workspace build.
for (const file of ['package-lock.json','node_modules/.package-lock.json']) {
  const lock = await read(path.join(host,file))
  for (const [relative,manifest] of Object.entries(lock.packages ?? {})) {
    if (relative && !keep.has(path.resolve(host,relative))) delete lock.packages[relative]
    else omitExcludedDependencies(manifest)
  }
  await fs.writeFile(path.join(host,file),JSON.stringify(lock,null,2) + '\n')
}
const auditFile = path.join(modules,'.heron-ai-distribution.json')
let previous
try { previous = await read(auditFile) } catch (error) { if (error.code !== 'ENOENT') throw error }
const retainedNames = new Set([...packages.values()].filter(pkg => keep.has(pkg.location)).map(pkg => pkg.name))
const names = [...new Set([...(previous?.removed ?? []),...removed.map(pkg => pkg.name)])]
  .filter(name => !retainedNames.has(name)).sort()
// Trim only generated third-party runtime copies. Inspector (including its sources),
// DSH sources, skills, legal notices, JS entry points and native runtime binaries stay intact.
let trimmedFiles = 0, trimmedBytes = 0
for (const pkg of packages.values()) {
  if (!keep.has(pkg.location) || pkg.name.includes('inspector')) continue
  const context = await distributionFileContext(pkg.location,pkg.manifest)
  async function trim(directory) {
    for (const entry of await fs.readdir(directory,{ withFileTypes:true })) {
      if (entry.name === 'node_modules') continue // Nested packages have their own inventory records.
      const file = path.join(directory,entry.name)
      if (entry.isSymbolicLink()) throw Error('AI runtime files cannot be links: ' + file)
      if (entry.isDirectory()) { await trim(file); continue }
      const relative = path.relative(pkg.location,file).replaceAll('\\','/')
      if (!discardDistributionFile(relative,context)) continue
      if (!path.resolve(file).toLowerCase().startsWith(modulePrefix)) throw Error('Invalid AI file prune target')
      const stat = await fs.stat(file)
      await fs.unlink(file)
      trimmedFiles++; trimmedBytes += stat.size
    }
  }
  await trim(pkg.location)
}
await recordAssemblyTransforms(host,transforms)
await fs.writeFile(auditFile,JSON.stringify({ version:2,removed:names,packages:keep.size,
  runtimeFiles:{ policy:1,inspector:'retained',trimmedFiles,trimmedBytes } },null,2) + '\n')
console.log(`[ai-distribution] ${removed.length} packages removed; ${keep.size} retained`)
console.log(`[ai-distribution] ${trimmedFiles} development/duplicate files removed (${(trimmedBytes / 1048576).toFixed(1)} MiB)`)
