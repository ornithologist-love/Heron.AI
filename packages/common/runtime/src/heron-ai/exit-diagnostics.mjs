// Opt-in observation through Cordis events. The launcher still owns shutdown.
import { Context } from '@deepseek-ai/cordis'

// Cordis 4.0.5 exposes FiberState as an erased const enum, as in app-boot.
/** @type {import('@deepseek-ai/cordis').FiberState.UNLOADING} */
const FIBER_UNLOADING = 5

const enabled = process.env.HERON_AI_EXIT_TRACE === '1'
const pending = new Map()
const observedRoots = new WeakSet()
let started = false
const nameOf = fiber => {
  const name = String(fiber.name ?? 'root')
  return /^[\w@./:-]{1,160}$/.test(name) ? name : 'custom-plugin'
}
const trace = (stage, values = {}) => {
  if (!enabled) return
  try {
    process.stderr.write('[heron-ai-exit] ' + JSON.stringify({
      stage, pid: process.pid, at: Date.now(), ...values,
    }) + '\n')
  } catch { /* Diagnostics must not change the operation being observed. */ }
}

/** Attach process diagnostics before the official launcher starts. */
export function startExitDiagnostics() {
  if (!enabled || started) return
  started = true
  process.stdin.on('end', () => trace('dsh_stdin_eof'))
  process.on('beforeExit', code => trace('node_before_exit', { code, pending: pending.size }))
  process.on('exit', code => trace('node_exit', { code, pending: pending.size }))
  trace('diagnostics_attached')
}

/** Observe the native UNLOADING transition and the already-owned disposal promise. */
export function observeExitLifecycle(ctx) {
  if (!enabled || observedRoots.has(ctx.root)) return
  observedRoots.add(ctx.root)
  // The application root clears its effects before its children finish. Give
  // this read-only subscription its own lifetime, releasing it after root drain.
  // extend() shadows only the listener's effect owner, never an application service.
  const observer = new Context()
  const scope = ctx.root.extend({ fiber: observer.fiber })
  scope.on('internal/status', fiber => {
    if (fiber.state !== FIBER_UNLOADING || pending.has(fiber)) return
    const uid = fiber.uid, plugin = nameOf(fiber), root = fiber === ctx.root.fiber
    pending.set(fiber, plugin)
    trace(root ? 'dsh_root_dispose_begin' : 'dsh_plugin_dispose_begin', { uid, plugin })
    const finish = failed => {
      pending.delete(fiber)
      trace(failed ? 'dsh_plugin_dispose_failed'
        : root ? 'dsh_root_dispose_complete' : 'dsh_plugin_dispose_complete', { uid, plugin, pending: pending.size })
      if (root) void observer.fiber.dispose().catch(() => {})
    }
    void fiber.inertia.then(() => finish(false), () => finish(true))
  }, { global: true })
}

/** Record a product-owned request at its call site, without wrapping appExit. */
export function traceExitRequest(code) {
  trace('dsh_app_exit_requested', { code })
}

/** Observe the same EOF/readiness gate as exitOnStdinEnd; never request exit here. */
export function observeHostStdinExit(ctx) {
  if (!enabled) return
  let ended = false, active = true, cancelReady = () => {}
  const onEnd = () => {
    if (!active || ended) return
    ended = true
    cancelReady = ctx.appReady.onReady(() => traceExitRequest(0))
  }
  ctx.effect(() => {
    process.stdin.once('end', onEnd)
    if (process.stdin.readableEnded) queueMicrotask(onEnd)
    return () => {
      active = false
      cancelReady()
      process.stdin.off('end', onEnd)
    }
  }, 'heron-ai-exit: stdin observation')
}
