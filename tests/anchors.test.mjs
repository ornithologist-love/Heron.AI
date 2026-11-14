// Anchor: AGENTS.md
// Document alignment baseline: every first-party test file names the written fact it protects,
// and that document (and heading, when given) still exists. Upstream submodules keep their own rules.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { hasDocumentFragment } from './support/document-anchors.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const skipped = new Set(['node_modules', '.git', 'dist', '.cache'])
// Upstream submodules: DSH itself and the community packages.
const upstream = new Set([path.join(root, 'packages', 'dsh'), path.join(root, 'packages', 'community')])

function testFiles(directory, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (skipped.has(entry.name) || upstream.has(full)) continue
    if (entry.isDirectory()) testFiles(full, found)
    else if (/\.test\.m?js$/.test(entry.name)) found.push(full)
  }
  return found
}

test('every first-party test file is anchored to an existing document', () => {
  const files = [...testFiles(path.join(root, 'packages')), ...testFiles(path.join(root, 'tests'))]
  assert.ok(files.length > 1, 'first-party tests were not found')
  const problems = []
  for (const file of files) {
    const relative = path.relative(root, file)
    const header = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.startsWith('//'))
    const anchors = header.map(line => /^\/\/\s*Anchor:\s*(.+)$/.exec(line)?.[1].trim()).filter(Boolean)
    if (!anchors.length) problems.push(`${relative}: no // Anchor: header`)
    for (const anchor of anchors) {
      const [document, fragment] = anchor.split('#', 2)
      const target = path.join(root, document)
      if (!fs.existsSync(target)) { problems.push(`${relative}: anchor document missing: ${document}`); continue }
      if (fragment && !hasDocumentFragment(fs.readFileSync(target, 'utf8'), fragment))
        problems.push(`${relative}: anchor '${fragment}' not found in ${document}`)
    }
  }
  assert.deepEqual(problems, [])
})
