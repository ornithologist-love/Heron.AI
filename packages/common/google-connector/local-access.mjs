import { AsyncLocalStorage } from 'node:async_hooks'

const loopbacks = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export function isLocalBrowserOwner(connection, request) {
  if (!loopbacks.has(request.socket?.remoteAddress) || request.headers.authorization !== undefined
    || request.headers['x-dsh-model-remote'] !== undefined) return false
  const admission = connection.admit(request)
  return admission.peer === connection.browserPeer && admission.peer?.principal.kind === 'owner'
}

// The relay can use an owner API credential. Admit only fresh prompts that
// actually entered through this Host's local authenticated browser.
export function localGoogleTurns(ctx) {
  const prompt = new AsyncLocalStorage()
  const pending = new WeakMap()
  const active = new WeakMap()

  ctx.on('connection/request', (request, _response, next) => {
    if (request.method !== 'POST' || request.url?.split('?')[0] !== '/api/session/prompt'
      || !isLocalBrowserOwner(ctx.connection, request)) return next()
    return prompt.run(true, next)
  })
  ctx.on('session/event', (session, event) => {
    if (!prompt.getStore() || event.type !== 'agent/inbox/spliced') return
    let ids = pending.get(session)
    if (!ids) pending.set(session, ids = new Set())
    for (const message of event.data.inserted) {
      if (message.source.kind === 'user' && message.source.principal === undefined) ids.add(message.id)
    }
  })
  ctx.on('agent/pre-step', ({ agent, turn, messages }, next) => {
    const input = messages.filter(message => message.source.kind === 'user' || message.source.kind === 'retry')
    if (input.length) {
      const ids = pending.get(agent.session)
      const local = input.map(message => ids?.delete(message.id) === true).every(Boolean)
      active.set(agent, { turn, local: local && (active.get(agent)?.turn !== turn || active.get(agent).local) })
    } else if (active.get(agent)?.turn !== turn) active.delete(agent)
    return next()
  })
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'running') active.delete(agent)
  })
  return agent => agent !== undefined && active.get(agent)?.local === true
}
