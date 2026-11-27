// Anchor: Docs/architecture/extensions.md#身份与模型通道集成
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createGoogleAuth } from '../auth.mjs'

const desktopClientId = 'fixture.apps.googleusercontent.com'
const driveScope = 'https://www.googleapis.com/auth/drive.readonly'
const docsScope = 'https://www.googleapis.com/auth/documents'
const sheetsScope = 'https://www.googleapis.com/auth/spreadsheets'

function createFixture(fetchImpl, openBrowser, requestedScopes) {
  const records = new Map()
  let writes = Promise.resolve()
  const credentials = {
    async readRecord(key) { return records.get(key) },
    async deleteRecord(key) { records.delete(key) },
    modifyRecord(key, mutate) {
      const write = writes.then(async () => {
        const next = await mutate(records.get(key))
        if (next) records.set(key, next)
        return records.get(key)
      })
      writes = write.catch(() => {})
      return write
    },
  }
  let flow, current, completion
  const authorization = {
    registerFlow(next) {
      flow = next
      return () => this.cancel()
    },
    describe() { return { inFlight: Boolean(current) } },
    begin({ method, interaction }) {
      current = new AbortController()
      completion = flow.run({
        method: method ?? flow.methods[0].id,
        signal: current.signal,
        notify: interaction.notify,
        commit: grant => credentials.modifyRecord(flow.key, async () => grant),
      }).finally(() => { current = undefined })
      return completion
    },
    cancel() { current?.abort() },
  }
  const opened = Promise.withResolvers()
  const auth = createGoogleAuth({ credentials, authorization, fetchImpl, requestedScopes, openAuthorizationUrl(url) {
    opened.resolve(url)
    return openBrowser?.(url)
  } })
  return { auth, browserUrl: opened.promise, finished: () => completion, records }
}

async function answerConsent(authorizationUrl, fields) {
  const url = new URL(authorizationUrl)
  const callback = new URL(url.searchParams.get('redirect_uri'))
  callback.search = new URLSearchParams({ state: url.searchParams.get('state'), ...fields })
  const response = await fetch(callback)
  await response.text()
  return response.status
}

test('Google OAuth binds PKCE and nonce, refreshes once per grant, and never exposes secrets in status', async () => {
  let authorizeUrl
  let calls = 0
  const { auth, browserUrl, finished, records } = createFixture(async (url, { body }) => {
    calls += 1
    assert.equal(body.get('client_id'), url.endsWith('/revoke') ? null : desktopClientId)
    if (url.endsWith('/revoke')) {
      assert.equal(body.get('token'), 'fixture-refresh')
      return new Response(null, { status: 200 })
    }
    if (body.get('grant_type') === 'refresh_token') {
      assert.equal(body.get('refresh_token'), 'fixture-refresh')
      return Response.json({ access_token: 'fixture-refreshed', expires_in: 3600 })
    }
    assert.equal(body.get('grant_type'), 'authorization_code')
    assert.equal(body.get('code'), 'fixture-code')
    assert.equal(body.get('redirect_uri'), authorizeUrl.searchParams.get('redirect_uri'))
    const expected = createHash('sha256').update(body.get('code_verifier')).digest('base64url')
    assert.equal(expected, authorizeUrl.searchParams.get('code_challenge'))
    return Response.json({ access_token: 'fixture-initial', refresh_token: 'fixture-refresh', expires_in: 30 })
  })
  try {
    await auth.configure({ clientId: desktopClientId, clientSecret: 'fixture-secret' })
    const starting = await auth.connect()
    assert.equal(starting.connecting, true)
    authorizeUrl = await browserUrl
    assert.equal(authorizeUrl.origin, 'https://accounts.google.com')
    assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(authorizeUrl.searchParams.get('scope'), [driveScope, docsScope].join(' '))
    const callback = new URL(authorizeUrl.searchParams.get('redirect_uri'))
    callback.searchParams.set('code', 'fixture-code')
    callback.searchParams.set('state', 'foreign-state')
    const invalid = await fetch(callback)
    assert.equal(invalid.status, 400)
    await invalid.text()
    assert.equal(calls, 0)
    callback.searchParams.set('state', authorizeUrl.searchParams.get('state'))
    const accepted = await fetch(callback)
    assert.equal(accepted.status, 200)
    await accepted.text()
    await finished()
    assert.deepEqual(await auth.status(), { configured: true, connected: true, connecting: false,
      grantedScopes: [driveScope, docsScope] })
    // Older grants did not persist scopes. The two original scopes still work.
    delete records.get('google-connector/workspace').payload.scopes
    await assert.rejects(auth.getAccessToken({ scopes: [sheetsScope] }), /此工具所需/)
    assert.deepEqual(await Promise.all([
      auth.getAccessToken({ scopes: [driveScope] }),
      auth.getAccessToken({ scopes: [docsScope] }),
    ]), ['fixture-refreshed', 'fixture-refreshed'])
    assert.deepEqual((await auth.status()).grantedScopes, [driveScope, docsScope])
    assert.equal(calls, 2)
    assert.equal((await auth.disconnect()).connected, false)
    assert.equal(calls, 3)
  } finally {
    auth.dispose()
  }
})

test('Google OAuth scopes follow the request, and partial consent preserves an existing grant', async () => {
  let requested = [driveScope, sheetsScope]
  let granted = driveScope
  const { auth, finished } = createFixture(async (_url, { body }) => {
    assert.equal(body.get('grant_type'), 'authorization_code')
    return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, scope: granted })
  }, undefined, () => requested)
  try {
    await auth.configure({ clientId: desktopClientId })
    const initial = await auth.connect({ method: 'manual' })
    assert.equal(new URL(initial.authorizationUrl).searchParams.get('scope'), [driveScope, sheetsScope].join(' '))
    requested = [driveScope, docsScope]
    assert.equal(await answerConsent(initial.authorizationUrl, { code: 'fixture-code' }), 200)
    await finished()
    assert.deepEqual((await auth.status()).grantedScopes, [driveScope])
    assert.equal(await auth.getAccessToken({ scopes: [driveScope] }), 'fixture-access')
    await assert.rejects(auth.getAccessToken({ scopes: [sheetsScope] }), /此工具所需/)

    const decline = await auth.connect({ method: 'manual' })
    assert.equal(new URL(decline.authorizationUrl).searchParams.get('scope'), requested.join(' '))
    assert.equal(await answerConsent(decline.authorizationUrl, { error: 'access_denied' }), 400)
    await assert.rejects(finished(), /授权未完成/)
    assert.deepEqual((await auth.status()).grantedScopes, [driveScope])

    granted = docsScope
    const partial = await auth.connect({ method: 'manual' })
    assert.equal(await answerConsent(partial.authorizationUrl, { code: 'fixture-code' }), 400)
    await assert.rejects(finished(), /保留原连接/)
    assert.deepEqual((await auth.status()).grantedScopes, [driveScope])
  } finally {
    auth.dispose()
  }
})

test('Google OAuth refuses an access token if refresh drops a required scope', async () => {
  const { auth, finished } = createFixture(async (_url, { body }) => {
    if (body.get('grant_type') === 'refresh_token') {
      return Response.json({ access_token: 'fixture-refreshed', expires_in: 3600, scope: driveScope })
    }
    return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 30 })
  })
  try {
    await auth.configure({ clientId: desktopClientId })
    const status = await auth.connect({ method: 'manual' })
    assert.equal(await answerConsent(status.authorizationUrl, { code: 'fixture-code' }), 200)
    await finished()
    await assert.rejects(auth.getAccessToken({ scopes: [docsScope] }), /此工具所需/)
    assert.deepEqual((await auth.status()).grantedScopes, [driveScope])
    assert.equal(await auth.getAccessToken({ scopes: [driveScope] }), 'fixture-refreshed')
  } finally {
    auth.dispose()
  }
})

test('browser failure leaves a usable authorization link until the user cancels', async () => {
  const { auth, browserUrl } = createFixture(async () => assert.fail('Unexpected call to Google'), () => {
    throw new Error('browser launch failed')
  })
  try {
    await auth.configure({ clientId: desktopClientId })
    await auth.connect()
    const authorizeUrl = await browserUrl
    const pending = await auth.status()
    assert.equal(pending.connecting, true)
    assert.equal(pending.authorizationUrl, authorizeUrl.href)
    assert.equal(pending.browserFailed, true)
    assert(!pending.authorizationUrl.includes('client_secret'))
    const disconnected = await auth.disconnect()
    assert.deepEqual(disconnected, { configured: true, connected: false, connecting: false })
    const callback = new URL(authorizeUrl.searchParams.get('redirect_uri'))
    callback.searchParams.set('code', 'fixture-code')
    callback.searchParams.set('state', authorizeUrl.searchParams.get('state'))
    await assert.rejects(fetch(callback))
  } finally {
    auth.dispose()
  }
})

test('copying a link prepares a new attempt without launching the browser', async () => {
  let launches = 0
  const { auth } = createFixture(async () => assert.fail('Unexpected call to Google'), () => { launches += 1 })
  try {
    await auth.configure({ clientId: desktopClientId })
    const manual = await auth.connect({ method: 'manual' })
    assert.equal(manual.connecting, true)
    assert.equal(new URL(manual.authorizationUrl).origin, 'https://accounts.google.com')
    assert.equal(manual.browserFailed, false)
    assert.equal(launches, 0)
    assert.equal((await auth.disconnect()).authorizationUrl, undefined)
  } finally {
    auth.dispose()
  }
})
