import { AsyncLocalStorage } from 'node:async_hooks'

const header = 'x-dsh-model-grant'
const remoteHeader = 'x-dsh-model-remote'

export function createModelGateway(ctx, address, { allowLocal = false, now = Date.now } = {}) {
  if (!address) return undefined
  const url = new URL(address)
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && url.hostname === '127.0.0.1') ||
    url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/api/model-gateway/'))
    throw Error('Invalid model gateway URL')

  const incoming = new AsyncLocalStorage()
  const pending = new Map(), active = new Map(), managed = new Map()
  const lastSource = new WeakMap()
  const requestKey = (session, request) => `${session}\0${request}`
  const validGrant = grant => grant && grant.expiresAt > now()
  const valid = state => state?.local === true || validGrant(state?.grant)
  const identity = state => state?.local ? null : state?.grant?.user
  const remoteRequest = req => !allowLocal || (req
    ? req.headers[remoteHeader] === '1' || req.headers[header] !== undefined
    : incoming.getStore()?.remote === true)
  const callState = session => active.get(session) ?? (incoming.getStore()?.remote
    ? { grant: incoming.getStore().accepted?.grant?.session === session ? incoming.getStore().accepted.grant : undefined }
    : allowLocal ? { local: true } : undefined)

  ctx.on('connection/request', (req, _res, next) => {
    const value = req.headers[header]
    const remote = req.headers[remoteHeader] === '1' || value !== undefined
    let grant
    if (typeof value === 'string' && value.length <= 2048 && /^[\w-]+\.[\w-]+$/.test(value)) {
      try { grant = JSON.parse(Buffer.from(value.split('.')[0], 'base64url').toString('utf8')) }
      catch { /* Malformed remote authorization remains remote and fails closed. */ }
      if (typeof grant?.user !== 'string' || !Number.isSafeInteger(grant.expiresAt) || !validGrant(grant)) grant = undefined
    }
    return incoming.run({ remote, grant: grant && { ...grant, value } }, next)
  })

  ctx.on('agent/pre-step', ({ agent, messages, turn, modelSelection }, next) => {
    const session = agent.session.id
    const current = active.get(session)
    let state = current?.turn === turn ? current : undefined
    const consumed = []
    for (const message of messages) {
      if (message.source?.kind !== 'user') continue
      const key = requestKey(session, message.source.rpcId), submitted = pending.get(key)
      if (!valid(submitted) || state && identity(state) !== identity(submitted)) {
        active.delete(session)
        return { kind: 'reject' }
      }
      state = submitted
      consumed.push(key)
    }
    for (const key of consumed) pending.delete(key)
    if (!state && allowLocal && lastSource.get(agent) !== 'remote') state = { local: true }
    if (!valid(state) || !state.local && !managed.has(modelSelection.provider)) {
      active.delete(session)
      return { kind: 'reject' }
    }
    lastSource.set(agent, state.local ? 'local' : 'remote')
    active.set(session, { ...state, turn })
    return next()
  })

  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') active.delete(agent.session.id)
  })

  ctx.on('llm-pi-ai/request-route', (request, _route, next) => {
    const inherited = next(), state = callState(request.sessionId)
    if (state?.local) return inherited
    const endpoint = managed.get(request.provider)
    if (!validGrant(state?.grant) || !endpoint)
      throw Error('模型调用缺少有效的当前用户授权，请从远程入口重新发起对话。')
    return { baseURL: endpoint, apiKey: 'gateway', headers: { Authorization: 'Bearer gateway' } }
  })

  ctx.on('llm-pi-ai/request-headers', (request, _headers, next) => {
    const state = callState(request.sessionId)
    if (state?.local) return next()
    if (!validGrant(state?.grant) || managed.get(request.provider) !== request.baseURL.replace(/\/$/, ''))
      throw Error('模型调用缺少有效的当前用户授权，请从远程入口重新发起对话。')
    const result = next()
    result.set(header, state.grant.value)
    result.set('x-dsh-model-session', request.sessionId)
    return result
  })

  return {
    exclusive: !allowLocal,
    isRemoteRequest: remoteRequest,
    requiresPersonalGrant: session => !callState(session)?.local,
    endpoint(definition, catalog) {
      if (definition.public || !definition.credential || catalog.api !== 'openai-completions' || !catalog.base_url?.startsWith('https://')) return undefined
      const baseUrl = new URL(encodeURIComponent(definition.id), url).href
      managed.set(definition.id, baseUrl)
      return { api: 'openai-completions', baseUrl }
    },
    supports: provider => managed.has(provider),
    removeProvider: provider => managed.delete(provider),
    async prompt(request, provider, next) {
      const grant = incoming.getStore()?.grant
      const state = remoteRequest() ? { grant } : { local: true }
      if (!state.local && (!validGrant(grant) || grant.session !== request.sessionId || grant.request !== request.requestId))
        throw Error('远程对话缺少有效的个人 Provider 授权，请重新登录并发送消息。')
      if (!state.local && !managed.has(provider)) throw Error('请为本次对话选择已接入网关的个人 Provider。')
      for (const [key, value] of pending) if (!valid(value) || value.pendingUntil <= now()) pending.delete(key)
      const session = request.sessionId, current = active.get(session)
      if (valid(current) && identity(current) !== identity(state) || [...pending].some(([key, value]) =>
        key.startsWith(`${session}\0`) && identity(value) !== identity(state)))
        throw Error('这个会话正由另一位用户执行，请等待完成或新开会话。')
      const key = requestKey(session, request.requestId)
      if (incoming.getStore()) incoming.getStore().accepted = state
      if (pending.has(key)) return next()
      if (pending.size >= 2048) throw Error('待处理模型授权过多，请稍后重试。')
      pending.set(key, { ...state, pendingUntil: now() + 3600000 })
      try { return await next() }
      catch (error) { pending.delete(key); throw error }
    },
  }
}
