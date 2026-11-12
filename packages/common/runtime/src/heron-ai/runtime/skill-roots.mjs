// Resolves user skill roots for the chat runtime. Instance skills live in
// <stateDir>/.agents/skills. Bundled HERON_AI skills under the plugin's `Skills/`
// are deploy-copied there on start (missing names only, never overwriting a
// local copy), and the former read-only-reference migration's `skills-legacy`
// leftovers are folded back into `skills` on the next start.
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { skillRoots } from './local-context.mjs'

// Deployed layout: <plugin>/AiHost/skill-roots.mjs with <plugin>/Skills beside it.
export function resolveBundledSkillsDirectory() {
  const assemblyDirectory = path.dirname(fileURLToPath(import.meta.url))
  return path.join(path.dirname(assemblyDirectory), 'skills')
}

// Names of the bundled skills: direct subdirectories that hold a SKILL.md.
// Dot-prefixed entries, symbolic links and directories without SKILL.md are not
// skills, and a missing root simply has no skills.
export function skillNames(root) {
  const names = new Set()
  if (typeof root !== 'string' || !root || !fs.existsSync(root)) return names
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue
    if (fs.existsSync(path.join(root, entry.name, 'SKILL.md'))) names.add(entry.name)
  }
  return names
}

// User-managed skill roots: the data root first (per-instance, Debug scoped)
// followed by the generic agent-framework roots under the home directory.
export function userSkillRoots(stateDir, includeHome = true) {
  return [path.join(stateDir, '.agents', 'skills'), ...(includeHome ? skillRoots() : [])]
}

// Earlier launches copied HERON_AI business skills into the instance's user root.
// Retire only byte-identical bundles when that aspect is disabled. Archive them
// outside all skill roots; never delete or move a user's edited/symlinked copy.
export function retireBundledSkills(bundledDirectory, stateDir, log = () => {}) {
  const digest = directory => {
    const hash = createHash('sha256')
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) return null
      const file = path.join(directory, entry.name)
      const value = entry.isDirectory() ? digest(file) : entry.isFile() ? fs.readFileSync(file) : null
      if (value === null) return null
      hash.update(entry.name).update('\0').update(value).update('\0')
    }
    return hash.digest('hex')
  }
  const skillsRoot = path.join(stateDir, '.agents', 'skills')
  if (!fs.existsSync(skillsRoot) || fs.lstatSync(skillsRoot).isSymbolicLink()) return 0
  let retired = 0
  for (const name of skillNames(bundledDirectory)) {
    const target = path.join(skillsRoot, name)
    if (!fs.existsSync(target) || !fs.lstatSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink()) continue
    const original = digest(path.join(bundledDirectory, name))
    if (original === null || digest(target) !== original) continue
    const archive = path.join(stateDir, '.agents', 'inactive-heron-ai-skills')
    fs.mkdirSync(archive, { recursive: true })
    fs.renameSync(target, path.join(archive, name + '-' + randomUUID()))
    retired++
  }
  if (retired) log(`inactive HERON_AI bundled skills archived: ${retired}`)
  return retired
}

// Pi reads the bridged list first-come-first-served, so the data root goes
// first and shadows same-named skills from the generic roots.
export function piSkillPaths(userRoots) {
  const paths = []
  const seen = new Set()
  for (const root of userRoots ?? []) {
    if (typeof root !== 'string' || !root || !fs.existsSync(root)) continue
    if (seen.has(root)) continue
    seen.add(root)
    paths.push(root)
  }
  return paths
}

// Fold the former migration's leftovers back: every entry of
// <stateDir>/.agents/skills-legacy moves into <stateDir>/.agents/skills. A name
// that already exists under `skills` wins and the legacy copy is renamed with a
// timestamp suffix instead of being dropped. Afterwards the legacy root and the
// obsolete `.heron-ai-skills-v2` marker are removed. Returns the number moved.
export function restoreLegacySkills(stateDir, log = () => {}) {
  const agentsRoot = path.join(stateDir, '.agents')
  const legacyRoot = path.join(agentsRoot, 'skills-legacy')
  const skillsRoot = path.join(agentsRoot, 'skills')
  const marker = path.join(agentsRoot, '.heron-ai-skills-v2')
  let moved = 0
  if (fs.existsSync(legacyRoot)) {
    fs.mkdirSync(skillsRoot, { recursive: true })
    for (const entry of fs.readdirSync(legacyRoot, { withFileTypes: true })) {
      const source = path.join(legacyRoot, entry.name)
      let target = path.join(skillsRoot, entry.name)
      if (fs.existsSync(target)) target = path.join(skillsRoot, `${entry.name}-restored-${Date.now()}`)
      try {
        fs.renameSync(source, target)
        moved += 1
      } catch (error) {
        log(`legacy skill restore skipped for ${entry.name} (${error?.message ?? error})`)
      }
    }
    try {
      fs.rmSync(legacyRoot, { recursive: true, force: true })
    } catch (error) {
      log(`legacy skills root removal failed (${error?.message ?? error})`)
    }
  }
  try {
    if (fs.existsSync(marker)) fs.rmSync(marker)
  } catch { /* marker removal is best effort */ }
  if (moved > 0) log(`legacy skills restored: ${moved} -> ${skillsRoot}`)
  return moved
}

// Deploy-copy bundled skills into <stateDir>/.agents/skills: only names that
// are missing there are copied; an existing directory is never overwritten, so
// local edits always survive upgrades. Returns the number of skills copied.
export function deployBundledSkills(bundledDirectory, stateDir, log = () => {}) {
  if (typeof bundledDirectory !== 'string' || !bundledDirectory || !fs.existsSync(bundledDirectory)) return 0
  const skillsRoot = path.join(stateDir, '.agents', 'skills')
  fs.mkdirSync(skillsRoot, { recursive: true })
  let copied = 0
  for (const name of skillNames(bundledDirectory)) {
    const target = path.join(skillsRoot, name)
    if (fs.existsSync(target)) continue
    try {
      fs.cpSync(path.join(bundledDirectory, name), target, { recursive: true })
      copied += 1
    } catch (error) {
      log(`bundled skill deploy skipped for ${name} (${error?.message ?? error})`)
    }
  }
  if (copied > 0) log(`bundled skills deployed: ${copied} -> ${skillsRoot}`)
  return copied
}
