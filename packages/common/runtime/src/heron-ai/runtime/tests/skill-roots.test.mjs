import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { deployBundledSkills, piSkillPaths, restoreLegacySkills, skillNames, userSkillRoots } from '../skill-roots.mjs'

function tempState() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-skills-'))
}

function makeSkill(root, name, marker) {
  fs.mkdirSync(path.join(root, name), { recursive: true })
  fs.writeFileSync(path.join(root, name, 'SKILL.md'), `# ${name}\n`)
  if (marker) fs.writeFileSync(path.join(root, name, marker), marker)
}

test('restoreLegacySkills folds skills-legacy back and removes the root and marker', () => {
  const state = tempState()
  const agents = path.join(state, '.agents')
  fs.mkdirSync(path.join(agents, 'skills-legacy', 'mine'), { recursive: true })
  fs.writeFileSync(path.join(agents, 'skills-legacy', 'mine', 'SKILL.md'), '# mine\n')
  fs.writeFileSync(path.join(agents, '.heron-ai-skills-v2'), '')
  const moved = restoreLegacySkills(state)
  assert.equal(moved, 1)
  assert.equal(fs.existsSync(path.join(agents, 'skills', 'mine', 'SKILL.md')), true)
  assert.equal(fs.existsSync(path.join(agents, 'skills-legacy')), false)
  assert.equal(fs.existsSync(path.join(agents, '.heron-ai-skills-v2')), false)
})

test('restoreLegacySkills never overwrites an existing skill and renames the legacy copy', () => {
  const state = tempState()
  const agents = path.join(state, '.agents')
  makeSkill(path.join(agents, 'skills'), 'mine', 'local.txt')
  makeSkill(path.join(agents, 'skills-legacy'), 'mine', 'legacy.txt')
  const moved = restoreLegacySkills(state)
  assert.equal(moved, 1)
  assert.equal(fs.existsSync(path.join(agents, 'skills', 'mine', 'local.txt')), true)
  const restored = fs.readdirSync(path.join(agents, 'skills')).filter(name => name !== 'mine')
  assert.equal(restored.length, 1)
  assert.match(restored[0], /^mine-restored-\d+$/)
  assert.equal(fs.existsSync(path.join(agents, 'skills', restored[0], 'legacy.txt')), true)
})

test('restoreLegacySkills is a no-op without a legacy root', () => {
  const state = tempState()
  const moved = restoreLegacySkills(state)
  assert.equal(moved, 0)
})

test('deployBundledSkills copies only missing names and never overwrites local copies', () => {
  const state = tempState()
  const bundled = tempState()
  makeSkill(bundled, 'heron-ai-mcp-helper')
  makeSkill(bundled, 'heron-ai-weekly-report')
  makeSkill(path.join(state, '.agents', 'skills'), 'heron-ai-mcp-helper', 'edited.txt')
  makeSkill(path.join(state, '.agents', 'skills'), 'mine', 'local.txt')
  const copied = deployBundledSkills(bundled, state)
  assert.equal(copied, 1)
  assert.equal(fs.existsSync(path.join(state, '.agents', 'skills', 'heron-ai-weekly-report', 'SKILL.md')), true)
  assert.equal(fs.existsSync(path.join(state, '.agents', 'skills', 'heron-ai-mcp-helper', 'edited.txt')), true)
  assert.equal(fs.existsSync(path.join(state, '.agents', 'skills', 'mine', 'local.txt')), true)
})

test('deployBundledSkills returns 0 for a missing bundled root', () => {
  const state = tempState()
  assert.equal(deployBundledSkills(path.join(state, 'nope'), state), 0)
})

test('deploy then restore ordering keeps a single skills root', () => {
  const state = tempState()
  const bundled = tempState()
  makeSkill(bundled, 'heron-ai-mcp-helper')
  restoreLegacySkills(state)
  deployBundledSkills(bundled, state)
  const names = [...skillNames(path.join(state, '.agents', 'skills'))]
  assert.deepEqual(names.sort(), ['heron-ai-mcp-helper'])
  assert.equal(fs.existsSync(path.join(state, '.agents', 'skills-legacy')), false)
})

test('piSkillPaths lists existing user roots first and dedupes', () => {
  const state = tempState()
  const skills = path.join(state, '.agents', 'skills')
  makeSkill(skills, 'mine')
  const roots = userSkillRoots(state)
  assert.equal(roots[0], skills)
  const paths = piSkillPaths(roots)
  assert.equal(paths[0], skills)
  assert.deepEqual(piSkillPaths([skills, skills, path.join(state, 'nope')]), [skills])
})
