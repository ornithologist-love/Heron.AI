// Native shell adapter for the official DSH Web Host. DSH owns agent/tool
// shutdown and persistence; this plugin only reports state and binds shell EOF.
import { exitOnStdinEnd } from '@deepseek-ai/dsh-cmdline'
import { observeHostStdinExit } from './exit-diagnostics.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { ai_provider_definitions } from './acp/runtime/providers.mjs'
import { backendPreset } from './acp/providers.mjs'

export const inject = ['appReady', 'appExit', 'webServer', 'connection', 'agents', 'workspaceRegistry', 'sessionNavigationInput', 'themeBootstrap', 'hmr', 'clientModules']

export async function apply(ctx, config) {
  const emit = value => process.stdout.write(JSON.stringify(value) + '\n')
  if (config.shellToken) {
    const expected = Buffer.from('Bearer ' + config.shellToken)
    const root = ctx.root
    const logger = ctx.logger
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/heron-ai-host/reload', handler: async (req, res) => {
      const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
      const given = Buffer.from(String(req.headers.authorization ?? ''))
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) return reply(403, { error: 'Loopback only' })
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return reply(401, { error: 'Host token required' })
      if (req.method !== 'POST') return reply(405, { error: 'POST required' })
      try {
        const hmr = root.get('hmr')
        const result = await hmr.runExclusive(() => hmr.reconcileProfile())
        for (const warning of result.warnings) logger.warn(warning)
        if (result.restartReason !== undefined) logger.warn('Manual hot reload requires restart: %s', result.restartReason)
        if (result.pending.length) logger.warn('Manual hot reload left %d changed modules pending restart', result.pending.length)
        const modules = root.get('clientModules')
        for (const entry of modules.graph().entries) modules.rebuilt(entry.id)
        reply(200, { restartRequired: result.restartReason !== undefined || result.pending.length > 0,
          pending: result.pending.length, warnings: result.warnings.length })
      } catch (error) {
        logger.warn(error)
        reply(500, { error: 'AI hot reload failed; see runtime logs' })
      }
    } }))
  }
  // The process cwd is a host data directory, not a user workspace. Repair
  // registrations left by the former startup path without deleting chats/files.
  const internalRoots = [config.localRoot, config.stateDir, config.home,
    path.join(config.stateDir, 'runtime-cwd')].filter(Boolean)
  const canonical = value => path.resolve(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  for (const workspace of ctx.workspaceRegistry.list()) {
    if (internalRoots.some(root => canonical(root) === canonical(workspace.path)))
      await ctx.workspaceRegistry.delete(workspace.id)
  }
  ctx.on('webserver/index-inject', table => {
    const devServer = config.hmrEnabled ? process.env.HERON_AI_UI_DEV_SERVER : undefined
    if (devServer) {
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(devServer)) throw Error('HeronAI UI dev server must be loopback HTTP')
      table.push({ kind: 'global', name: '__HERON_AI_UI_DEV_SERVER__', value: devServer })
    }
    table.push({ kind: 'global', name: '__HERON_AI_DSH_WORKSPACE__', value: config.workspace })
    table.push({ kind: 'global', name: '__HERON_AI_DSH_PROVIDERS__',
      value: ai_provider_definitions.map(item => ({ id: item.id, name: item.name, public: item.public, preset: backendPreset(item.id) })) })
    table.push({ kind: 'global', name: '__HERON_AI_DSH_NAVIGATION__', value: ctx.sessionNavigationInput.current() })
  })
  const inFlight = new Set()
  let previousBusy
  const activity = () => {
    const busy = inFlight.size > 0 || ctx.agents.list().some(agent => agent.status === 'running')
    if (busy !== previousBusy) { previousBusy = busy; emit({ event: 'activity', busy }) }
  }
  ctx.on('tools/execute', (execution, next) => {
    inFlight.add(execution.token)
    activity()
    return next()
  })
  ctx.on('tools/result', execution => {
    inFlight.delete(execution.token)
    activity()
  })
  ctx.on('agent/status', activity)
  ctx.on('agent/disposed', activity)
  ctx.on('agent/created', activity)
  ctx.effect(() => ctx.appReady.onReady(async () => {
    if (config.hmrEnabled && !ctx.get('hmr')) throw Error('Automatic HMR failed to initialize')
    activity()
    const ready = { event: 'ready', port: ctx.webServer.port, pid: process.pid,
      url: ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}/`), runtime: 'dsh',
      startupMs: config.startupStartedAt ? Date.now() - config.startupStartedAt : undefined,
      hmr: config.hmrEnabled }
    if (config.readyFile) {
      await fs.mkdir(path.dirname(config.readyFile), { recursive: true })
      await fs.writeFile(config.readyFile, JSON.stringify(ready))
    }
    emit(ready)
  }), 'heron-ai-host.ready')
  // The shell owns this input stream; the official launcher owns the exit
  // request, cancellation and complete plugin-tree teardown. Signal handling
  // also remains with the launcher.
  observeHostStdinExit(ctx)
  exitOnStdinEnd(ctx, 'heron-ai-host.stdin')
  ctx.effect(() => {
    process.stdin.resume()
    return () => process.stdin.pause()
  }, 'heron-ai-host.input')
}
