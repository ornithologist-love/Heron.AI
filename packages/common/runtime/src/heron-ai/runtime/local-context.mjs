// Ported from the former C# AiLocalContext: file scanning, project inspection,
// executable discovery and bounded process execution for the AI chat host.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const SKIPPED_DIRECTORIES = new Set([
  '.git', 'node_modules', 'bin', 'obj', 'dist', 'saved', 'Intermediate', 'Binaries', 'DerivedDataCache',
])

// One-shot runtime commands (provider probes, git queries) run in a
// dedicated scratch cwd under the chat home so they never touch a project.
export function isolatedWorkspace(chatHome) {
  const root = path.join(chatHome, 'runtime-cwd')
  fs.mkdirSync(root, { recursive: true })
  return root
}

export async function getProject(projectPath) {
  const root = path.resolve(projectPath)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('项目目录不存在')
  let branch = null
  try {
    branch = (await runAsync('git', ['-C', root, 'branch', '--show-current'], root)).trim()
    if (!branch) branch = 'detached · ' + (await runAsync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], root)).trim()
  } catch { /* A workspace need not be a Git repository. */ }
  return { path: root, name: path.basename(root), branch: branch || null }
}

export function findFiles(root, query, { skillsOnly = false } = {}) {
  if (!root || typeof root !== 'string' || !fs.existsSync(root)) return []
  const files = []
  const queue = [path.resolve(root)]
  let scanned = 0
  while (queue.length > 0 && scanned++ < 3000 && files.length < 100) {
    const current = queue.shift()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'EACCES' || error?.code === 'EPERM') continue
      throw error
    }
    for (const entry of entries) {
      let isSymlink = false
      try {
        isSymlink = entry.isSymbolicLink()
      } catch { /* stat failures fall through as regular entries */ }
      if (isSymlink) continue
      if (entry.isDirectory()) {
        // Dot-prefixed directories (e.g. `.system` inside `.codex/skills`)
        // are provider built-ins, not user-installable skills: browsing must
        // not surface them next to real skills.
        if (skillsOnly && entry.name.startsWith('.')) continue
        if (!SKIPPED_DIRECTORIES.has(entry.name)) queue.push(path.join(current, entry.name))
        continue
      }
      if (skillsOnly && entry.name.toLowerCase() !== 'skill.md') continue
      const fullPath = path.join(current, entry.name)
      const relative = path.relative(root, fullPath)
      if (relative.toLowerCase().includes(String(query ?? '').toLowerCase()))
        files.push({ path: fullPath, name: skillsOnly ? path.basename(current) : relative })
      if (files.length === 100) break
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  return files
}

export function resolveFile(root, filePath) {
  const fullRoot = path.resolve(root)
  const fullPath = path.resolve(fullRoot, filePath)
  const rootWithSep = removeTrailingSeparator(fullRoot) + path.sep
  if (!fullPath.toLowerCase().startsWith(rootWithSep.toLowerCase())) throw new Error('文件不在所选目录中')
  for (let current = fullPath; ; current = path.dirname(current)) {
    if (isSymlink(current)) throw new Error('暂不支持通过符号链接引用文件')
    if (current.toLowerCase() === fullRoot.toLowerCase()) break
    if (path.dirname(current) === current) break
  }
  return fullPath
}

export async function readTextFile(root, filePath) {
  const fullPath = resolveFile(root, filePath)
  if (fs.statSync(fullPath).size > 512 * 1024) throw new Error('文件超过 512 KB，请在消息中引用文件路径和需要查看的范围')
  const content = await fs.promises.readFile(fullPath, 'utf8')
  if (content.includes('\0')) throw new Error('请选择文本文件；图片可通过 + 添加')
  return content
}

// Only generic agent-framework skill directories are scanned. Platform-specific
// skill roots hold skills that cannot run outside their own platform, so they
// are never treated as generic roots.
export function skillRoots(workspace) {
  const user = os.homedir()
  const roots = []
  for (const root of [workspace, user]) {
    if (!root || typeof root !== 'string') continue
    for (const folder of ['.agents', '.claude', '.codex'])
      roots.push(path.join(root, folder, 'skills'))
  }
  return roots
}

export function resolveExecutable(candidates) {
  for (const candidate of candidates ?? []) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue
    const expanded = expandEnvironment(candidate.trim())
    if (expanded.includes('%')) continue
    if (path.isAbsolute(expanded) && fs.existsSync(expanded)) return path.resolve(expanded)
    if (expanded.includes('/') || expanded.includes('\\')) continue
    for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!directory) continue
      const fullPath = path.join(directory.trim().replace(/^"|"$/g, ''), expanded)
      if (fs.existsSync(fullPath)) return path.resolve(fullPath)
    }
  }
  return null
}

export function expandEnvironment(value) {
  return value.replaceAll(/%([^%]+)%/g, (match, name) => {
    const replacement = process.env[name]
    return replacement === undefined ? match : replacement
  })
}

export function runAsync(executable, args, cwd, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: cwd ?? undefined,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already exited */ }
      reject(new Error(`${path.basename(executable)} 执行超时`))
    }, timeoutMs)
    const append = (chunk, target) => {
      if (target.length < 4 * 1024 * 1024) target += chunk.toString('utf8')
      return target
    }
    child.stdout.on('data', chunk => { stdout = append(chunk, stdout) })
    child.stderr.on('data', chunk => { stderr = append(chunk, stderr) })
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`${path.basename(executable)} 执行失败（${code}）`))
      else resolve(stdout)
    })
  })
}

function removeTrailingSeparator(value) {
  return value.endsWith(path.sep) || value.endsWith('/') ? value.slice(0, -1) : value
}

function isSymlink(target) {
  try {
    return fs.lstatSync(target).isSymbolicLink()
  } catch {
    return false
  }
}
