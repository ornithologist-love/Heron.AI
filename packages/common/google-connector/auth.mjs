import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'

const clientKey = 'google-connector/desktop-client'
const accountKey = 'google-connector/workspace'
const tokenUrl = 'https://oauth2.googleapis.com/token'
const legacyScopes = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents',
]

class GoogleAuthError extends Error {}

const grantScopes = grant => grant.scopes ?? legacyScopes
const includesScopes = (available, required) => required.every(scope => available.includes(scope))

function requireScopes(grant, required) {
  if (!includesScopes(grantScopes(grant), required)) {
    throw new GoogleAuthError('请在 Google Connector 中授权此工具所需的 Google 权限。')
  }
}

function reply(response, status, message) {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  })
  response.end(message)
}

async function authorize(client, scopes, openAuthorizationUrl, store, signal, reportBrowser) {
  const duration = AbortSignal.timeout(5 * 60_000)
  const lifetime = AbortSignal.any([signal, duration])
  const state = randomBytes(32).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const callback = Promise.withResolvers()
  let accepted = false
  const server = createServer((request, response) => {
    let url
    try { url = new URL(request.url, 'http://127.0.0.1') }
    catch { return reply(response, 400, '授权回调无效。') }
    if (request.method !== 'GET' || url.pathname !== '/') return reply(response, 404, '地址无效。')
    const code = url.searchParams.get('code')
    const error = url.searchParams.get('error')
    if (accepted || url.searchParams.get('state') !== state || !code && !error) {
      return reply(response, 400, '授权回调无效。')
    }
    accepted = true
    callback.resolve({ code, error, response })
  })
  const withdrawn = Promise.withResolvers()
  void withdrawn.promise.catch(() => {})
  const abort = () => withdrawn.reject(new GoogleAuthError(duration.aborted ? 'Google 授权已超时。' : 'Google 授权已取消。'))
  lifetime.addEventListener('abort', abort, { once: true })
  let response
  try {
    lifetime.throwIfAborted()
    const listening = once(server, 'listening', { signal: lifetime })
    server.listen(0, '127.0.0.1')
    await listening
    const redirectUri = 'http://127.0.0.1:' + server.address().port + '/'
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.search = new URLSearchParams({
      client_id: client.id, redirect_uri: redirectUri, response_type: 'code',
      scope: scopes.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256',
      access_type: 'offline', prompt: 'consent',
    }).toString()
    const browser = { url: url.href, failed: false }
    reportBrowser(browser)
    // Keep the same login alive if the user needs to open the link manually.
    if (openAuthorizationUrl) {
      void Promise.resolve().then(() => openAuthorizationUrl(url)).catch(() => { browser.failed = true })
    }
    const result = await Promise.race([callback.promise, withdrawn.promise])
    response = result.response
    if (result.error) throw new GoogleAuthError('Google 授权未完成。')
    await store({ code: result.code, redirectUri, verifier }, lifetime)
    reply(response, 200, 'Google Suite 已连接，可以关闭此页。')
  } catch (error) {
    if (response) reply(response, 400, 'Google 授权未完成，请回到 Heron 查看。')
    throw error
  } finally {
    reportBrowser(undefined)
    lifetime.removeEventListener('abort', abort)
    server.close()
    if (!response) server.closeAllConnections()
  }
}

export function createGoogleAuth({ credentials, authorization, openAuthorizationUrl, requestedScopes = () => legacyScopes, fetchImpl = fetch }) {
  const read = async key => (await credentials.readRecord(key))?.payload
  const record = payload => ({ kind: 'grant', payload })
  const connected = (client, grant) => Boolean(client && grant?.clientRevision === client.revision && grant.refreshToken)
  let error
  let pending
  let browser
  let browserReady
  let operations = Promise.resolve()
  const serialize = run => {
    const operation = operations.then(run)
    operations = operation.catch(() => {})
    return operation
  }

  async function requestToken(client, parameters, fallbackScopes, signal) {
    const response = await fetchImpl(tokenUrl, {
      method: 'POST', redirect: 'error',
      body: new URLSearchParams({ client_id: client.id, ...(client.secret && { client_secret: client.secret }), ...parameters }),
      signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(20_000)]),
    })
    const body = await response.json().catch(() => null)
    if (!response.ok && body?.error === 'invalid_grant') return undefined
    if (!response.ok || typeof body?.access_token !== 'string' || !body.access_token
      || !Number.isFinite(body.expires_in) || body.expires_in <= 0) {
      throw new GoogleAuthError('Google 令牌交换失败，请检查 OAuth 客户端配置。')
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + body.expires_in * 1000,
      clientRevision: client.revision,
      scopes: typeof body.scope === 'string' ? [...new Set(body.scope.split(/\s+/).filter(Boolean))] : [...fallbackScopes],
    }
  }

  const unregister = authorization.registerFlow({
    key: accountKey,
    label: 'Google Suite',
    methods: [{ id: 'google', label: '连接 Google 账号' }, { id: 'manual', label: '复制授权链接' }],
    async run(session) {
      const client = await read(clientKey)
      if (!client) throw new GoogleAuthError('请先设置 Google 桌面应用 OAuth 客户端。')
      const scopes = [...new Set(await requestedScopes())]
      if (!scopes.length) throw new GoogleAuthError('请先启用至少一个 Google 工具集。')
      const launchBrowser = session.method === 'manual' ? undefined : openAuthorizationUrl
      await authorize(client, scopes, launchBrowser, async ({ code, redirectUri, verifier }, signal) => {
        const grant = await requestToken(client, {
          grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier,
        }, scopes, signal)
        if (!grant?.refreshToken) throw new GoogleAuthError('Google 未提供续期授权，请重新连接。')
        if (!scopes.some(scope => grant.scopes.includes(scope))) throw new GoogleAuthError('Google 未授予所请求的权限。')
        if ((await read(clientKey))?.revision !== client.revision) {
          throw new GoogleAuthError('Google OAuth 客户端已更改，请重新连接。')
        }
        const previous = await read(accountKey)
        if (connected(client, previous)) {
          const retained = grantScopes(previous).filter(scope => scopes.includes(scope))
          if (!includesScopes(grant.scopes, retained)) {
            throw new GoogleAuthError('Google 未授予全部已有权限，已保留原连接。')
          }
        }
        signal.throwIfAborted()
        await session.commit(record(grant))
      }, session.signal, current => {
        browser = current
        if (current) session.notify({ message: '在浏览器中完成 Google 授权。', url: current.url })
      })
    },
  })

  async function status() {
    const [client, grant] = await Promise.all([read(clientKey), read(accountKey)])
    const isConnected = connected(client, grant)
    const state = { configured: Boolean(client), connected: isConnected,
      connecting: Boolean(authorization.describe(accountKey)?.inFlight),
      ...(isConnected && { grantedScopes: [...grantScopes(grant)] }),
      ...(browser && { authorizationUrl: browser.url, browserFailed: browser.failed }) }
    return error ? { ...state, error } : state
  }

  async function cancelAuthorization() {
    authorization.cancel(accountKey)
    await pending
    error = undefined
  }

  return {
    status,
    configure({ clientId, clientSecret } = {}) {
      return serialize(async () => {
        if (authorization.describe(accountKey)?.inFlight) throw new GoogleAuthError('请先完成或取消当前授权。')
        const id = typeof clientId === 'string' ? clientId.trim() : ''
        const secret = typeof clientSecret === 'string' ? clientSecret.trim() : ''
        if (!/^[a-zA-Z0-9-]{1,180}\.apps\.googleusercontent\.com$/.test(id) || secret.length > 512) {
          throw new GoogleAuthError('Google 桌面应用 OAuth 客户端无效。')
        }
        const previous = await read(clientKey)
        if (id !== previous?.id || secret && secret !== previous.secret) {
          await credentials.modifyRecord(clientKey, async () => record({ id, secret, revision: randomUUID() }))
          await credentials.deleteRecord(accountKey)
        }
        error = undefined
        return status()
      })
    },
    connect({ method = 'google' } = {}) {
      return serialize(async () => {
        if (!await read(clientKey)) throw new GoogleAuthError('请先配置 Google OAuth 客户端。')
        if (!authorization.describe(accountKey)?.inFlight) {
          error = undefined
          const ready = Promise.withResolvers()
          browserReady = ready.promise
          pending = authorization.begin({ key: accountKey, method, interaction: {
            notify: ready.resolve,
            async prompt() { throw new GoogleAuthError('请在浏览器完成 Google 授权。') },
          } }).catch(failure => {
            error = failure instanceof GoogleAuthError ? failure.message : '无法连接 Google Suite，请重试。'
          })
        }
        if (method === 'manual' && browserReady) await Promise.race([browserReady, pending])
        return status()
      })
    },
    cancel() {
      return serialize(async () => {
        await cancelAuthorization()
        return status()
      })
    },
    disconnect() {
      return serialize(async () => {
        await cancelAuthorization()
        const grant = await read(accountKey)
        await credentials.deleteRecord(accountKey)
        if (grant?.refreshToken) {
          try {
            const response = await fetchImpl('https://oauth2.googleapis.com/revoke', {
              method: 'POST', redirect: 'error', body: new URLSearchParams({ token: grant.refreshToken }),
              signal: AbortSignal.timeout(8_000),
            })
            if (!response.ok) throw new Error('revocation failed')
          } catch {
            error = '已断开本地连接，Google 授权撤销未确认。'
          }
        }
        return status()
      })
    },
    async getAccessToken({ scopes = [], signal } = {}) {
      const client = await read(clientKey)
      const grant = await read(accountKey)
      if (!connected(client, grant)) throw new GoogleAuthError('请先在 Google Connector 中连接 Google 账号。')
      signal?.throwIfAborted()
      requireScopes(grant, scopes)
      if (grant.expiresAt - Date.now() > 60_000) return grant.accessToken
      const result = await credentials.modifyRecord(accountKey, async current => {
        const currentGrant = current?.payload
        if (!connected(client, currentGrant) || currentGrant.expiresAt - Date.now() > 60_000) return undefined
        signal?.throwIfAborted()
        requireScopes(currentGrant, scopes)
        const refreshed = await requestToken(client, {
          grant_type: 'refresh_token', refresh_token: currentGrant.refreshToken,
        }, grantScopes(currentGrant), signal)
        if (!refreshed) return record({ clientRevision: client.revision })
        return record({ ...refreshed, refreshToken: refreshed.refreshToken ?? currentGrant.refreshToken })
      })
      signal?.throwIfAborted()
      if (!connected(await read(clientKey), result?.payload)) {
        throw new GoogleAuthError('Google 授权已失效，请重新连接。')
      }
      requireScopes(result.payload, scopes)
      return result.payload.accessToken
    },
    dispose() { unregister() },
  }
}
