import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { bundleFileIncluded } from '../packages/common/runtime/src/heron-ai/package-files.mjs'

export { bundleFileIncluded }

const nameList = value => value === undefined || Array.isArray(value)
  && value.every(name => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name))

const relativeList = value => value === undefined || Array.isArray(value)
  && value.every(name => typeof name === 'string' && name && !path.isAbsolute(name) && !name.split(/[\\/]/).includes('..'))

// A composition entry is a package directory, or { path, skills?, mcpServers?, excludeFiles? }
// that keeps only the named skills and MCP servers of that package and drops
// the listed package files together with the Markdown lines linking to them.
function compositionEntry(entry) {
  if (typeof entry === 'string') return entry.trim() ? { path: entry } : undefined
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.path !== 'string' || !entry.path.trim()
    || Object.keys(entry).some(key => !['path', 'skills', 'mcpServers', 'excludeFiles'].includes(key))
    || !nameList(entry.skills) || !nameList(entry.mcpServers) || !relativeList(entry.excludeFiles)) return undefined
  return entry
}

// Composition is an explicit build input owned by the distributor, outside the
// public product. A plain build never discovers sibling repositories.
export function pluginBundleInputs(manifestFile, directories = []) {
  const manifestFiles = new Set()
  const selections = new Map()
  let mcpSecretsFile
  if (manifestFile && directories.length) throw Error('Choose --bundle-manifest or --bundle-plugin, not both')
  if (manifestFile) {
    const active = new Set()
    const read = file => {
      file = path.resolve(file)
      if (active.has(file) || active.size >= 8) throw Error('Plugin composition inheritance cycle or excessive depth')
      active.add(file); manifestFiles.add(file)
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))
      const entries = Array.isArray(manifest.plugins) ? manifest.plugins.map(compositionEntry) : undefined
      if (manifest.version !== 1 || !entries || entries.includes(undefined)
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
      return [...inherited, ...entries.map(entry => {
        const directory = path.resolve(path.dirname(file), entry.path)
        if (entry.skills || entry.mcpServers || entry.excludeFiles)
          selections.set(directory, { skills: entry.skills, mcpServers: entry.mcpServers, excludeFiles: entry.excludeFiles })
        return directory
      })]
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
    const selection = selections.get(directory)
    if (selection) validateSelection(directory, manifest, selection)
  }
  return { directories: resolved, manifestFiles, mcpSecretsFile, selections }
}

// The package declares where its skills live; a selection names only what exists.
export function skillsRoot(manifest) {
  const root = manifest.heronAi?.skills
  if (root === undefined) return undefined
  if (typeof root !== 'string' || !root || path.isAbsolute(root) || root.split(/[\\/]/).includes('..'))
    throw Error('Invalid skills directory: ' + manifest.name)
  return root.replace(/[\\/]+$/, '')
}

function validateSelection(directory, manifest, { skills, mcpServers, excludeFiles }) {
  for (const relative of excludeFiles ?? [])
    if (!fs.statSync(path.join(directory, relative), { throwIfNoEntry: false })?.isFile())
      throw Error('Excluded bundle file does not exist: ' + manifest.name + '/' + relative)
  if (skills) {
    const root = skillsRoot(manifest)
    if (!root) throw Error('Skill selection needs heronAi.skills in ' + manifest.name)
    for (const name of skills)
      if (!fs.statSync(path.join(directory, root, name, 'SKILL.md'), { throwIfNoEntry: false })?.isFile())
        throw Error('Selected skill does not exist: ' + manifest.name + '/' + name)
  }
  if (mcpServers) {
    const content = manifest.heronAi?.content?.['mcp-config.json']
    if (!content) throw Error('MCP selection needs heronAi.content mcp-config.json in ' + manifest.name)
    const servers = JSON.parse(fs.readFileSync(path.join(directory, content), 'utf8')).mcpServers ?? {}
    for (const name of mcpServers)
      if (!Object.hasOwn(servers, name)) throw Error('Selected MCP server does not exist: ' + manifest.name + '/' + name)
  }
}

// Whether a package-relative path survives the composition's skill selection.
export function selectedFile(manifest, selection, relative) {
  if (selection?.excludeFiles?.some(file => path.normalize(file) === path.normalize(relative))) return false
  if (!selection?.skills) return true
  const parts = relative.split(/[\\/]/).filter(Boolean)
  const root = skillsRoot(manifest).split(/[\\/]/)
  if (parts.length <= root.length || root.some((part, index) => parts[index] !== part)) return true
  return selection.skills.includes(parts[root.length])
}

// The MCP servers of a package's config that the composition keeps.
export function selectedMcpServers(config, selection) {
  if (!selection?.mcpServers) return config
  return { ...config, mcpServers: Object.fromEntries(Object.entries(config.mcpServers ?? {})
    .filter(([name]) => selection.mcpServers.includes(name))) }
}

// Drops, from the copied package's Markdown, every line that links to an
// excluded file, so trimming a reference never leaves a dangling link.
export function dropExcludedLinks(target, selection) {
  if (!selection?.excludeFiles?.length) return
  const excluded = new Set(selection.excludeFiles.map(file => path.resolve(target, file)))
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) { visit(file); continue }
      if (!entry.name.endsWith('.md')) continue
      const text = fs.readFileSync(file, 'utf8')
      const lines = text.split('\n')
      const kept = lines.filter(line => ![...line.matchAll(/\]\(([^)\s]+)\)/g)].some(([, link]) =>
        !/^[a-z]+:/i.test(link) && excluded.has(path.resolve(path.dirname(file), decodeURI(link.split('#')[0])))))
      if (kept.length !== lines.length) fs.writeFileSync(file, kept.join('\n'))
    }
  }
  visit(target)
}
