import { AsyncLocalStorage } from 'node:async_hooks'

const header = 'x-dsh-model-grant'

export function createModelGateway(ctx, address) {
  if (!address) return undefined
  const url = new URL(address)
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && url.hostname === '127.0.0.1') ||
    url.username || url.password || url.search || url.hash || url.pathname !== '/api/model-gateway/')
    throw Error('Invalid model gateway URL')

  const incoming = new AsyncLocalStorage()
  const pending = new Map()
  const active = new Map()
  const managed = new Map()
  const requestKey = (session, request) => `${session}\0${request}`
  const valid = grant => grant && grant.expiresAt > Date.now()

  ctx.on('connection/request', (req, _res, next) => {
    const value = req.headers[header]
    if (typeof value !== 'string' || value.length > 2048 || !/^[\w-]+\.[\w-]+$/.test(value)) return next()
    let grant
    try { grant = JSON.parse(Buffer.from(value.split('.')[0], 'base64url').toString('utf8')) }
    catch { return next() }
    if (typeof grant?.user !== 'string' || !Number.isSafeInteger(grant.expiresAt) || !valid(grant)) return next()
    return incoming.run({ ...grant, value }, next)
  })

  ctx.on('agent/pre-step', ({ agent, messages, turn, modelSelection }, next) => {
    const session = agent.session.id
    const current = active.get(session)
    let grant = current?.turn === turn ? current.grant : undefined
    const consumed = []
    for (const message of messages) {
      if (message.source?.kind !== 'user') continue
      const key = requestKey(session, message.source.rpcId)
      const submitted = pending.get(key)
      if (!valid(submitted) || grant && grant.user !== submitted.user) {
        active.delete(session)
        return { kind: 'reject' }
      }
      grant = submitted
      consumed.push(key)
    }
    for (const key of consumed) pending.delete(key)
    if (!valid(grant) || !managed.has(modelSelection.provider)) {
      active.delete(session)
      return { kind: 'reject' }
    }
    active.set(session, { turn, grant })
    return next()
  })

  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') active.delete(agent.session.id)
  })

  ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
    const grant = active.get(request.sessionId)?.grant
    if (!valid(grant) || managed.get(request.provider) !== request.baseURL.replace(/\/$/, ''))
      throw Error('模型调用缺少有效的当前用户授权，请从网页重新发起对话。')
    const result = next()
    result.set(header, grant.value)
    result.set('x-dsh-model-session', request.sessionId)
    return result
  })

  return {
    endpoint(definition, catalog) {
      if (definition.public || !definition.credential || catalog.api !== 'openai-completions' || !catalog.base_url?.startsWith('https://')) return undefined
      const baseUrl = new URL(encodeURIComponent(definition.id), url).href
      managed.set(definition.id, baseUrl)
      return { api: 'openai-completions', baseUrl }
    },
    supports: provider => managed.has(provider),
    async prompt(request, provider, next) {
      const grant = incoming.getStore()
      if (!valid(grant) || grant.session !== request.sessionId || grant.request !== request.requestId)
        throw Error('请从已登录的网页入口发起对话，以使用个人 Provider。')
      if (!managed.has(provider)) throw Error('请为本次对话选择已接入网关的个人 Provider。')
      for (const [key, value] of pending) if (!valid(value)) pending.delete(key)
      const session = request.sessionId
      const current = active.get(session)?.grant
      if (valid(current) && current.user !== grant.user || [...pending].some(([key, value]) =>
        key.startsWith(`${session}\0`) && value.user !== grant.user))
        throw Error('这个会话正由另一位用户执行，请等待完成或新开会话。')
      const key = requestKey(session, request.requestId)
      if (pending.has(key)) return next()
      if (pending.size >= 2048) throw Error('待处理模型授权过多，请稍后重试。')
      pending.set(key, grant)
      try { return await next() }
      catch (error) { pending.delete(key); throw error }
    },
  }
}
