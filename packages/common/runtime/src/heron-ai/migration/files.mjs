import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

export const digest = value => createHash('sha256').update(value).digest('hex')
export const migrationRoot = options => path.join(options.home, 'migration', 'heron-ai-v1')
export const progress = stage => process.stdout.write(JSON.stringify({ event: 'migration', stage }) + '\n')
export async function readJson(file) {
  let text
  try { text = await fs.readFile(file, 'utf8') }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
  try { return JSON.parse(text.replace(/^\uFEFF/, '')) }
  catch { throw Error(`旧版 ${path.basename(file)} 格式无效，原文件已保留。`) }
}
export const saveJson = (file, value) => writeFileAtomic(file, JSON.stringify(value, null, 2), { mode: 0o600, dirMode: 0o700 })
export async function filesBelow(root, extension) {
  const files = []
  async function walk(directory) {
    let entries
    try { entries = await fs.readdir(directory, { withFileTypes: true }) }
    catch (error) { if (error.code === 'ENOENT') return; throw error }
    for (const entry of entries) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(file)
      else if (entry.isFile() && (!extension || entry.name.endsWith(extension))) files.push(file)
    }
  }
  await walk(root)
  return files.sort()
}
