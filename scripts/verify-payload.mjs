// Build gate for the AiHost payload: fail the build when the shipped AiHost directory
// cannot actually be loaded by Node.
//
// `node --check` only parses one file, so it never caught a payload that lost a module:
// ERR_MODULE_NOT_FOUND is a resolution failure, not a syntax error. The only reliable
// gate is to walk the import graph from each entry point and demand that every relative
// specifier resolves to a file that is actually present in the payload.
//
// Usage: node verify-payload.mjs <payloadRoot> [--source <sourceAiHostDir>]
//
//   payloadRoot   the assembled payload (.../AiHost, or the release root that contains AiHost/)
//   --source      optional source AiHost directory; when given, every module reachable in
//                 the payload must also exist in the source tree, which turns a payload
//                 that is silently behind the sources into a build error.
//
// Exit code 0 = payload is loadable, 1 = build must fail.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isBuiltin, createRequire } from 'node:module'
import { createHash } from 'node:crypto'

import { parseImports } from './import-graph.mjs'
import { excludedPackage } from '../packages/common/runtime/src/dsh/distribution.mjs'
import { verifyDevelopmentContext } from './plugin-dev-context.mjs'

const args = process.argv.slice(2)
let payloadRoot, sourceRoot
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--source') sourceRoot = args[++i]
  else if (!payloadRoot) payloadRoot = args[i]
  else throw new Error(`无法识别的参数：${args[i]}`)
}
if (!payloadRoot) throw new Error('用法：node verify-payload.mjs <payloadRoot> [--source <sourceAiHostDir>]')

const resolveHost = root => {
  // Accept either the AiHost directory itself or a release root that contains it.
  if (!fs.existsSync(root)) throw new Error(`AI 功能包目录不存在：${root}`)
  if (fs.existsSync(path.join(root, 'main.mjs'))) return root
  const nested = path.join(root, 'AiHost')
  if (fs.existsSync(path.join(nested, 'main.mjs'))) return nested
  throw new Error(`payload 里找不到 AiHost/main.mjs：${root}`)
}
const hostRoot = resolveHost(payloadRoot)
const forkRoster = JSON.parse(fs.readFileSync(path.join(hostRoot, 'dsh', 'forks.json'), 'utf8'))
const forkRecord = JSON.parse(fs.readFileSync(path.join(hostRoot, 'node_modules', '.heron-ai-dsh-forks.json'), 'utf8'))
if (JSON.stringify(forkRecord.forks) !== JSON.stringify(forkRoster)) throw Error('AI payload fork 清单不匹配')
for (const fork of forkRoster) {
  const name = fork.packageName ?? '@deepseek-ai/dsh-client-' + fork.directory
  const root = path.join(hostRoot, 'node_modules', name)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'heron-ai-fork.json'), 'utf8'))
  const digest = file => createHash('sha256').update(fs.readFileSync(path.join(root, 'lib', file))).digest('hex')
  if (manifest[fork.markerField ?? 'heronAiFork'] !== fork.marker || metadata.inputApi !== 1 || metadata.name !== name
      || metadata.version !== manifest.version
      || (fork.artifacts ?? ['index.js', 'client.js']).some(file => metadata.artifactSha256?.[file] !== digest(file))) throw Error('AI payload 源码 fork 不完整：' + name)
}
if (sourceRoot && !fs.existsSync(path.join(sourceRoot, 'main.mjs')))
  throw new Error(`源码 AiHost 目录无效：${sourceRoot}`)

// Node itself is the authority on whether a specifier resolves: it applies the ESM
// resolution algorithm (extensionless imports, directory/index fallback, package
// exports) instead of a hand-rolled path join that would drift from the runtime.
let resolveFromUrl
try {
  ({ resolve: resolveFromUrl } = await import('node:module'))
} catch { resolveFromUrl = null }
const resolveSpecifier = async (specifier, fromFile) => {
  if (resolveFromUrl) {
    try {
      const resolved = resolveFromUrl(specifier, pathToFileURL(fromFile).href)
      if (resolved) return resolved.startsWith('file:') ? new URL(resolved).pathname.replace(/^\/([A-Za-z]:)/, '$1') : null
    } catch { /* fall through to the manual walk below */ }
  }
  // Deprecated in Node 24, removed later, so it is only the fallback path.
  const { createRequire } = await import('node:module')
  try { return createRequire(fromFile).resolve(specifier) } catch { return null }
}

const decode = file => file.replace(/^\/([A-Za-z]:)/, '$1')
const relativeTo = (root, file) => path.relative(root, file).split(path.sep).join('/')
const isInside = (root, file) => {
  const r = path.relative(root, file)
  return !!r && !r.startsWith('..') && !path.isAbsolute(r)
}
const sameFile = (a, b) => {
  try { return fs.realpathSync(a) === fs.realpathSync(b) } catch { return false }
}

// Walk the import graph breadth-first from every entry point.
const queue = []
const seen = new Set()
const missing = []
const errors = []
const enqueue = (file, origin) => {
  const key = decode(path.resolve(file))
  if (seen.has(key)) return
  seen.add(key)
  queue.push({ file: key, origin })
}
for (const entry of ['main.mjs', 'heron-ai/entrypoints.mjs', 'heron-ai/extension-api.mjs'])
  enqueue(path.join(hostRoot, entry), '<entry>')
const bundleReport = []
const bundled = JSON.parse(fs.readFileSync(path.join(hostRoot, 'heron-ai/content/bundled-plugins.json'), 'utf8'))
for (const name of bundled) {
  const directory = path.join(hostRoot, 'node_modules', name)
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
  for (const relative of manifest.heronAi?.build?.requiredFiles ?? [])
    if (!fs.existsSync(path.join(directory, relative))) bundleReport.push('Optional component is missing: ' + name + '/' + relative)
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const file = path.join(current, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile() && entry.name.endsWith('.mjs')) enqueue(file, '<optional-component>')
    }
  }
  walk(directory)
}

while (queue.length) {
  const { file, origin } = queue.shift()
  const label = relativeTo(hostRoot, file)
  if (!fs.existsSync(file)) { missing.push(`${label}（被 ${relativeTo(hostRoot, origin)} 引用）`); continue }
  let imports
  try { imports = parseImports(fs.readFileSync(file, 'utf8'), file) }
  catch (error) { errors.push(`${label}: ${error.message}`); continue }
  for (const specifier of imports) {
    if (isBuiltin(specifier)) continue
    const resolved = await resolveSpecifier(specifier, file)
    if (!resolved) { missing.push(`${specifier}（被 ${label} 引用）`); continue }
    const target = decode(resolved)
    if (!isInside(hostRoot, target)) continue // bare specifier -> node_modules, checked separately
    // The payload ships flattened directories whose node_modules is generated during
    // packaging, so only the module tree is compared against the sources.
    if (isInside(path.join(hostRoot, 'node_modules'), target)) continue
    const inSource = relativeTo(hostRoot, target)
    if (sourceRoot && !isInside(path.join(hostRoot, 'node_modules'), file) && !fs.existsSync(path.join(sourceRoot, inSource)))
      errors.push(`${label} 引用的 ${inSource} 在源码 AiHost 中不存在（payload 落后于源码）`)
    enqueue(target, file)
  }
}

// A payload that lost a module is exactly what this gate exists to catch; say which file
// should have been added to the packaging list.
const report = [...bundleReport]
try {
  await verifyDevelopmentContext(hostRoot, sourceRoot ? path.resolve(sourceRoot, '../../ui/src') : undefined)
} catch (error) { report.push('Plugin developer context: ' + error.message) }
for (const retired of ['server.mjs', 'admission-store.mjs', 'session-store.mjs', 'acp.mjs', 'dsh/client.js', 'dsh/templates-client.js'])
  if (fs.existsSync(path.join(hostRoot, retired))) report.push(`AI 功能包仍包含已替换的旧入口：${retired}`)
if (missing.length) report.push(`AI 功能包缺少模块（Node 启动会 ERR_MODULE_NOT_FOUND）：\n  ${missing.join('\n  ')}`)
if (errors.length) report.push(`AI 功能包校验失败：\n  ${errors.join('\n  ')}`)

const required = ['LICENSE', 'THIRD-PARTY-NOTICES.md', 'main.mjs', 'dsh/launch.mjs', 'heron-ai/index.mjs', 'heron-ai/ui/widgets.js', 'dsh/web/index.html', 'heron-ai/content/templates/index.json', 'heron-ai/content/mcp-config.json', 'heron-ai/content/runtime-logo.svg', 'heron-ai/content/product.json', 'heron-ai/content/provider-catalog.json']
for (const file of required)
  if (!fs.existsSync(path.join(hostRoot, file))) report.push(`AI 功能包缺少 ${file}`)
try {
  await import(pathToFileURL(path.join(path.resolve(hostRoot), 'heron-ai', 'index.mjs')))
} catch (error) { report.push('HeronAi 功能包加载失败：' + error.message) }

// The sidecar loads its dependencies from the payload, so the lockfile and the packages
// the graph actually imports must be present.
if (!fs.existsSync(path.join(hostRoot, 'package.json'))) report.push('AI 功能包缺少 AiHost/package.json')
const nodeModules = path.join(hostRoot, 'node_modules')
for (const scope of fs.readdirSync(nodeModules,{ withFileTypes:true })) {
  if (!scope.isDirectory() || scope.name.startsWith('.')) continue
  const names = scope.name.startsWith('@')
    ? fs.readdirSync(path.join(nodeModules,scope.name)).map(name => scope.name + '/' + name)
    : [scope.name]
  for (const name of names) if (excludedPackage(name)) report.push('AI 功能包仍包含已移除能力：' + name)
}
if (!fs.existsSync(path.join(nodeModules,'.heron-ai-distribution.json'))) report.push('AI 功能包缺少产品裁剪记录')
if (process.platform === 'win32' && process.arch === 'x64') {
  for (const name of ['@microsoft/mxc-sdk', 'node-pty']) {
    const root = path.join(nodeModules, ...name.split('/'))
    if (!fs.existsSync(root)) continue
    const forbidden = []
    function checkNativePayload(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name)
        const relative = path.relative(root, file).replaceAll('\\', '/')
        if (entry.isDirectory()) { checkNativePayload(file); continue }
        const unusedMxc = name === '@microsoft/mxc-sdk' && (/^bin\/arm64\//.test(relative)
          || /^bin\/x64\/(?:libmxc_ffi\.so|lxc-exec|unix-test-proxy)$/.test(relative))
        if (unusedMxc || /\.pdb$/i.test(relative) || /^prebuilds\/win32-arm64\//.test(relative)) forbidden.push(relative)
      }
    }
    checkNativePayload(root)
    if (forbidden.length) report.push(`AI 功能包 ${name} 含非 win-x64 载荷或调试符号：\n  ${forbidden.join('\n  ')}`)
  }
}
const bare = new Set()
if (fs.existsSync(path.join(hostRoot, 'package.json')))
  for (const name of Object.keys(JSON.parse(fs.readFileSync(path.join(hostRoot, 'package.json'), 'utf8')).dependencies ?? {})) bare.add(name)
for (const file of seen) {
  if (!fs.existsSync(file)) continue
  try {
    for (const specifier of parseImports(fs.readFileSync(file, 'utf8'), file))
      if (!specifier.startsWith('.') && !specifier.startsWith('/') && !isBuiltin(specifier))
        bare.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0])
  } catch { /* reported above */ }
}
for (const name of [...bare].sort()) {
  const manifest = path.join(nodeModules, name, 'package.json')
  if (!fs.existsSync(manifest)) report.push(`AI 功能包缺少依赖 ${name}（AiHost/node_modules 不完整）`)
}

if (report.length) {
  console.error(`[ai-payload] 校验失败：${hostRoot}`)
  for (const block of report) console.error('  ' + block)
  console.error(`  已解析 ${seen.size} 个模块，入口：main.mjs`)
  process.exit(1)
}
console.log(`[ai-payload] 校验通过：${seen.size} 个模块可达，依赖 ${[...bare].sort().join(', ') || '无'}`)
