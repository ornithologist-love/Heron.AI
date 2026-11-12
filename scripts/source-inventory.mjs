import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const inventories = new Map()
// Git visibility is an admission boundary for first-party distribution inputs.
// Local ignored deployment files are never implicitly promoted into a payload.
export function visibleSourceFiles(root) {
  root = path.resolve(root)
  if (!inventories.has(root)) {
    const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
      .split('\0').filter(Boolean).map(file => path.resolve(root, file))
      .filter(file => fs.existsSync(file) && fs.lstatSync(file).isFile())
    inventories.set(root, new Set(files))
  }
  return inventories.get(root)
}
