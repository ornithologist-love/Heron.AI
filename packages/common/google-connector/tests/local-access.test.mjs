// Anchor: Docs/architecture/extensions.md#google-connector
import assert from 'node:assert/strict'
import test from 'node:test'
import { isLocalBrowserOwner, localGoogleTurns } from '../local-access.mjs'

const browserPeer = { principal: { kind: 'owner' } }
const bearerPeer = { principal: { kind: 'owner' } }
const connection = {
  browserPeer,
  admit: request => request.headers.cookie ? { peer: browserPeer } : { peer: bearerPeer },
}
const browser = {
  method: 'POST', url: '/api/session/prompt', headers: { cookie: 'mock' },
  socket: { remoteAddress: '127.0.0.1' },
}
const relay = {
  ...browser,
  headers: { authorization: 'Bearer mock', 'x-dsh-model-remote': '1' },
}

test('only the local authenticated browser may configure the connector', () => {
  assert.equal(isLocalBrowserOwner(connection, browser), true)
  assert.equal(isLocalBrowserOwner(connection, relay), false)
  assert.equal(isLocalBrowserOwner(connection, { ...browser, headers: {} }), false)
  assert.equal(isLocalBrowserOwner(connection, { ...browser, socket: { remoteAddress: '192.0.2.7' } }), false)
})

test('a local Google turn loses access when remote input enters it or it finishes', () => {
  const hooks = new Map()
  const ctx = { connection, on: (name, callback) => hooks.set(name, callback) }
  const isLocal = localGoogleTurns(ctx)
  const agent = { session: {} }
  const next = () => {}
  const submit = (request, message) => hooks.get('connection/request')(request, {}, () =>
    hooks.get('session/event')(agent.session, { type: 'agent/inbox/spliced', data: { inserted: [message] } }))
  const step = (turn, messages) => hooks.get('agent/pre-step')({ agent, turn, messages }, next)
  const user = id => ({ id, source: { kind: 'user' } })

  submit(browser, user('local-1'))
  step(1, [user('local-1')])
  assert.equal(isLocal(agent), true)
  step(1, [])
  assert.equal(isLocal(agent), true)
  submit(relay, user('remote'))
  step(1, [user('remote')])
  assert.equal(isLocal(agent), false)

  submit(browser, user('local-2'))
  step(2, [user('local-2')])
  assert.equal(isLocal(agent), true)
  hooks.get('agent/status')({ agent, status: 'idle' })
  step(3, [user('local-2')])
  assert.equal(isLocal(agent), false)
})
