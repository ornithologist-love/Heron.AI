// Anchor: Docs/architecture/extensions.md#会话归档
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { apply } from '../index.mjs'

function fixture() {
  const browserPeer = { principal: { kind: 'owner' } }
  const bearerPeer = { principal: { kind: 'owner' } }
  const sharedPeer = { principal: { kind: 'authorized' } }
  const deleted = []
  let route
  apply({
    effect: register => register(),
    webServer: { register: registered => { route = registered } },
    connection: { browserPeer, admit: request => request.admission },
    sessionController: { deleteArchivedSession: id => deleted.push(id) },
  })
  assert.equal(route.path, '/heron-ai-session-archive')

  async function request({ method = 'GET', admission = { peer: browserPeer }, address = '127.0.0.1',
    headers = {}, body } = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    Object.assign(req, { method, admission, headers, socket: { remoteAddress: address } })
    const result = {}
    await route.handler(req, {
      writeHead: status => { result.status = status },
      end: text => { result.body = JSON.parse(text) },
    })
    return result
  }
  return { request, browserPeer, bearerPeer, sharedPeer, deleted }
}

const mutationHeaders = { 'content-type': 'application/json', 'x-heron-archive-action': 'delete' }

test('the local owner browser submits the native session ID to permanent deletion', async () => {
  const h = fixture()
  assert.deepEqual(await h.request(), { status: 200, body: { canDelete: true } })
  const result = await h.request({ method: 'POST', headers: mutationHeaders,
    body: { sessionId: 'archived-1', file: '<workspace file>' } })
  assert.deepEqual(result, { status: 200, body: { ok: true } })
  assert.deepEqual(h.deleted, ['archived-1'])
})

test('permanent deletion is unavailable to relays, shares, and nonlocal browsers', async () => {
  const h = fixture()
  const attempts = [
    { admission: { peer: h.bearerPeer }, headers: { authorization: 'Bearer mock-token' } },
    { admission: { peer: h.sharedPeer } },
    { headers: { 'x-dsh-model-remote': '1' } },
    { headers: { authorization: 'Bearer mock-token' } },
    { address: '192.0.2.1' },
  ]
  for (const attempt of attempts) {
    assert.deepEqual(await h.request(attempt), { status: 200, body: { canDelete: false } })
    assert.equal((await h.request({ ...attempt, method: 'POST',
      headers: { ...mutationHeaders, ...attempt.headers }, body: { sessionId: 'archived-1' } })).status, 403)
  }
  assert.equal((await h.request({ method: 'POST', headers: { 'content-type': 'application/json' },
    body: { sessionId: 'archived-1' } })).status, 403)
  assert.deepEqual(h.deleted, [])
})
