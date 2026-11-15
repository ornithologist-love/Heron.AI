// A distributor that renamed its product describes the former identity; the runtime knows no former name.
// Descriptors come from packages shipped in this payload (manifest field heronAi.legacyIdentity), read before
// the user's profile selection exists, because migration has to run before that selection is loaded.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url))
const shippedFile = fileURLToPath(new URL('../content/bundled-plugins.json', import.meta.url))
const fields = new Set(['version', 'stateDirectories', 'chatDirectories', 'localDirectories', 'identifiers', 'prefixes',
  'stateRenames', 'profilePackages', 'packageFields', 'presetPrefixes'])

export const emptyLegacyIdentity = Object.freeze({ stateDirectories: [], chatDirectories: [], localDirectories: [],
  identifiers: Object.freeze(Object.create(null)), prefixes: [], stateRenames: [], profilePackages: [], packageFields: [],
  presetPrefixes: [] })

const fail = (source, message) => { throw Error(`Invalid legacy identity in ${source}: ${message}`) }
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\0\r\n]/.test(value)
const name = value => text(value) && value !== '.' && value !== '..' && !/[\\/:]/.test(value)
const relative = value => text(value) && !path.isAbsolute(value) && !/^[a-zA-Z]:/.test(value)
  && value.split(/[\\/]/).every(part => part && part !== '.' && part !== '..')
const list = (source, key, value, valid) => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => !valid(item))) fail(source, key)
  return [...value]
}
const pairs = (source, key, value, valid) => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(pair => !Array.isArray(pair) || pair.length !== 2 || !valid(pair[0]) || !valid(pair[1])))
    fail(source, key)
  return value.map(([from, to]) => [from, to])
}

/** Validate one descriptor document; `source` names it in errors. */
export function parseLegacyIdentity(value, source = 'descriptor') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(source, 'not an object')
  if (value.version !== 1) fail(source, 'version must be 1')
  for (const key of Object.keys(value)) if (!fields.has(key)) fail(source, 'unknown field ' + key)
  const identifiers = Object.create(null)
  if (value.identifiers !== undefined) {
    if (!value.identifiers || typeof value.identifiers !== 'object' || Array.isArray(value.identifiers)) fail(source, 'identifiers')
    for (const [from, to] of Object.entries(value.identifiers)) {
      if (!text(from) || !text(to)) fail(source, 'identifiers')
      identifiers[from] = to
    }
  }
  return {
    stateDirectories: list(source, 'stateDirectories', value.stateDirectories, name),
    chatDirectories: list(source, 'chatDirectories', value.chatDirectories, name),
    localDirectories: list(source, 'localDirectories', value.localDirectories, name),
    identifiers,
    prefixes: pairs(source, 'prefixes', value.prefixes, text),
    stateRenames: pairs(source, 'stateRenames', value.stateRenames, relative),
    profilePackages: list(source, 'profilePackages', value.profilePackages, text),
    packageFields: pairs(source, 'packageFields', value.packageFields, name),
    presetPrefixes: list(source, 'presetPrefixes', value.presetPrefixes, text),
  }
}

/** Combine descriptors; two packages may not map the same former identifier differently. */
export function mergeLegacyIdentities(descriptors) {
  const result = { ...emptyLegacyIdentity, identifiers: Object.create(null) }
  for (const key of ['stateDirectories', 'chatDirectories', 'localDirectories', 'prefixes', 'stateRenames',
    'profilePackages', 'packageFields', 'presetPrefixes']) result[key] = []
  for (const descriptor of descriptors) {
    for (const [from, to] of Object.entries(descriptor.identifiers)) {
      if (Object.hasOwn(result.identifiers, from) && result.identifiers[from] !== to) throw Error('Conflicting legacy identifier: ' + from)
      result.identifiers[from] = to
    }
    for (const key of Object.keys(result)) if (key !== 'identifiers') result[key].push(...descriptor[key])
  }
  return result
}

/** Read the descriptor a package manifest declares, confined to that package and free of links. */
export function readPackageLegacyIdentity(root, manifest) {
  const declared = manifest.heronAi?.legacyIdentity
  if (declared === undefined) return null
  if (typeof declared !== 'string') fail(manifest.name, 'heronAi.legacyIdentity must be a path')
  root = path.resolve(root)
  const file = path.resolve(root, declared), below = path.relative(root, file)
  if (!below || below.startsWith('..') || path.isAbsolute(below)) fail(manifest.name, 'descriptor must stay inside its package')
  for (let current = file; current !== root; current = path.dirname(current))
    if (fs.lstatSync(current).isSymbolicLink()) fail(manifest.name, 'descriptor cannot use symbolic links')
  return parseLegacyIdentity(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')), manifest.name)
}

/** Descriptors of every package this payload ships, enabled or not. */
export function loadShippedLegacyIdentity({ shipped, resolveFrom = runtimeRoot } = {}) {
  if (shipped === undefined) {
    try { shipped = JSON.parse(fs.readFileSync(shippedFile, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return emptyLegacyIdentity; throw error }
  }
  const require = createRequire(path.join(resolveFrom, 'package.json'))
  const descriptors = []
  for (const packageName of shipped) {
    let manifestFile
    try { manifestFile = require.resolve(packageName + '/package.json') } catch { continue }
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    const descriptor = readPackageLegacyIdentity(path.dirname(manifestFile), manifest)
    if (descriptor) descriptors.push(descriptor)
  }
  return descriptors.length ? mergeLegacyIdentities(descriptors) : emptyLegacyIdentity
}

let shippedIdentity
/** The payload's descriptor, read once per process. */
export function legacyIdentity() {
  return shippedIdentity ??= loadShippedLegacyIdentity()
}

/** Map one former identifier: exact entries first, then prefix rules in their declared order. */
export function renameIdentifier(value, identity = legacyIdentity()) {
  if (typeof value !== 'string') return value
  if (Object.hasOwn(identity.identifiers, value)) return identity.identifiers[value]
  for (const [from, to] of identity.prefixes) if (value.startsWith(from)) return to + value.slice(from.length)
  return value
}
