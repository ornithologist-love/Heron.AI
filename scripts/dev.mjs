// One command for local work: build the product, start the sidecar on a private
// state directory, and open its authenticated page once it reports ready.
// Extra arguments go to the sidecar, e.g. `npm run dev -- --host-integration heronAi`.
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mobile = process.argv.includes('--mobile')
const args = process.argv.slice(2).filter(arg => arg !== '--mobile')

const build = spawnSync(process.execPath, [path.join(root, 'scripts', 'build.mjs')], { cwd: root, stdio: 'inherit' })
if (build.status !== 0) process.exit(build.status ?? 1)

// The sidecar exits when its stdin closes, so it keeps this terminal's input.
const stateDir = args.includes('--state-dir') ? [] : ['--state-dir', path.join(root, '.cache', mobile ? 'mobile-preview' : 'dev-state')]
const host = spawn(process.execPath, [path.join(root, 'dist', 'app', 'AiHost', 'main.mjs'), ...stateDir, ...args],
  { cwd: root, stdio: ['inherit', 'pipe', 'inherit'], env: { ...process.env,
    HERON_AI_HOST_METADATA: JSON.stringify({ source: 'cli',
      ...(process.env.HERON_AI_HOST_METADATA ? JSON.parse(process.env.HERON_AI_HOST_METADATA) : {}), build: 'debug' }),
    ...(mobile ? { HERON_AI_MOBILE_PREVIEW_FILE: path.join(root, 'scripts/mobile-preview.html') } : {}) } })
let opened = false
createInterface({ input: host.stdout }).on('line', line => {
  let event
  try { event = JSON.parse(line) } catch { /* ordinary runtime log */ }
  if (event?.event !== 'ready') { process.stdout.write(line + '\n'); return }
  if (opened) return
  try {
    const target = new URL(event.url)
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password)
      throw Error('Expected a loopback sidecar URL')
    if (mobile) target.pathname = '/__heron_ai_mobile_preview.html'
    opened = true
    process.stdout.write(`\nHeronAI ${mobile ? '手机预览' : 'ready'}: ${target.origin}${target.pathname}\n按 Ctrl+C 退出\n\n`)
    const [command, params] = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', target.href]]
      : process.platform === 'darwin' ? ['open', [target.href]] : ['xdg-open', [target.href]]
    const browser = spawn(command, params, { stdio: 'ignore', detached: true, windowsHide: true })
    browser.on('error', () => process.stderr.write('浏览器未能自动打开。\n'))
    browser.unref()
  } catch { process.stderr.write('Invalid sidecar ready URL.\n'); host.stdin?.end(); host.kill() }
})
host.on('exit', code => process.exit(code ?? 0))
