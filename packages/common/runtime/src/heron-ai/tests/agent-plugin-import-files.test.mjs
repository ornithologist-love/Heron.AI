import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { zipSync } from 'fflate'
import { extractAgentPluginZip } from '../agent-plugins/import-files.mjs'

// Anchor: Docs/architecture/extensions.md#导入-agent-plugin

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-plugin-zip-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, destination: path.join(root, 'unpacked') }
}

test('reads the archive on a safe relative path and verifies the file contents', async t => {
  const { destination } = await fixture(t)
  await extractAgentPluginZip(zipSync({ 'skills/demo/SKILL.md': Buffer.from('mock skill') }), destination)
  assert.equal(await readFile(path.join(destination, 'skills', 'demo', 'SKILL.md'), 'utf8'), 'mock skill')
})

test('rejects unsafe paths, aliases and symbolic links before writing ZIP files', async t => {
  const { root, destination } = await fixture(t)
  const payload = Buffer.from('mock')
  const anchored = path.join(root, 'outside.txt')
  await writeFile(anchored, 'outside')
  for (const entries of [
    { '../outside.txt': payload },
    { 'C:/local.txt': payload },
    { 'skills/A/guide.md': payload, 'skills/a/SKILL.md': payload },
    { 'skills/NUL.txt': payload },
    { 'link': [payload, { os: 3, attrs: 0xa1ff0000 }] },
  ]) {
    await assert.rejects(extractAgentPluginZip(zipSync(entries), destination), /路径|符号链接/)
  }
  assert.deepEqual(await readdir(root), ['outside.txt'])
  assert.equal(await readFile(anchored, 'utf8'), 'outside')
})

test('rejects ZIP metadata exceeding the entry or unpacked size budget', async t => {
  const { root, destination } = await fixture(t)
  const oversized = Buffer.from(zipSync({ 'plugin.json': Buffer.from('small content') }))
  const centralDirectory = oversized.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  oversized.writeUInt32LE(65 * 1024 * 1024, centralDirectory + 24)
  await assert.rejects(extractAgentPluginZip(oversized, destination), /64 MiB/)
  const crowded = Object.fromEntries(Array.from({ length: 2049 }, (_, index) => ['a' + index, Buffer.alloc(0)]))
  await assert.rejects(extractAgentPluginZip(zipSync(crowded), destination), /2,048/)
  assert.deepEqual(await readdir(root), [])
})
