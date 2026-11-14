// Anchor: Docs/architecture/extensions.md#身份与模型通道集成
import assert from 'node:assert/strict'
import test from 'node:test'
import { createModelGateway } from '../model-gateway.mjs'

const mockContext = () => ({ on() {} })

test('a host without a gateway address is not managed', () => {
  assert.equal(createModelGateway(mockContext(), undefined), undefined)
})

test('gateway addresses may sit below a public prefix but never carry credentials or leave TLS', () => {
  for (const address of ['https://gateway.example/api/model-gateway/', 'https://gateway.example/orchard/api/model-gateway/', 'http://127.0.0.1:9/api/model-gateway/'])
    assert.ok(createModelGateway(mockContext(), address), address)
  for (const address of ['http://gateway.example/api/model-gateway/', 'https://user:pass@gateway.example/api/model-gateway/',
    'https://gateway.example/api/model-gateway/?x=1', 'https://gateway.example/api/model-gateway', 'https://gateway.example/api/other/'])
    assert.throws(() => createModelGateway(mockContext(), address), /Invalid model gateway URL/, address)
})

function harness(allowLocal = true) {
  const events = new Map()
  let clock = 1000
  const gateway = createModelGateway({ on: (name, listener) => events.set(name, listener) },
    'https://gateway.example/api/model-gateway/', { allowLocal, now: () => clock })
  gateway.endpoint({ id: 'personal', credential: {} }, { api: 'openai-completions', base_url: 'https://provider.example/v1' })
  const agent = { session: { id: 'mock-session' } }
  const envelope = (changes = {}) => Buffer.from(JSON.stringify({ user: 'mock-user', session: agent.session.id,
    request: 'mock-request', expiresAt: 2000, ...changes })).toString('base64url') + '.mock-signature'
  const connection = (headers, next) => events.get('connection/request')({ headers }, {}, next)
  const prompt = (provider = 'personal', requestId = 'mock-request') => gateway.prompt({ sessionId: agent.session.id, requestId }, provider, () => 'accepted')
  const step = (messages = [{ source: { kind: 'user', rpcId: 'mock-request' } }], turn = 1, provider = 'personal') =>
    events.get('agent/pre-step')({ agent, messages, turn, modelSelection: { provider } }, () => 'allowed')
  const idle = () => events.get('agent/status')({ agent, status: 'idle' })
  const route = (provider = 'personal') => events.get('llm-pi-ai/request-route')({ provider, sessionId: agent.session.id }, undefined, () => undefined)
  const headers = (baseURL = 'https://gateway.example/api/model-gateway/personal') => {
    const result = new Headers({ Authorization: 'Bearer fixture' })
    return events.get('llm-pi-ai/request-headers')({ provider: 'personal', sessionId: agent.session.id, baseURL }, result, () => result)
  }
  return { gateway, envelope, connection, prompt, step, idle, route, headers, expire: () => { clock = 3000 } }
}

test('mixed hosts retain local chat, public channels and local background steps', async () => {
  const h = harness()
  assert.equal(await h.connection({}, () => h.prompt('public')), 'accepted')
  assert.equal(h.step(undefined, 1, 'public'), 'allowed')
  assert.equal(h.route('public'), undefined)
  assert.equal(h.headers('https://local.example').get('authorization'), 'Bearer fixture')
  assert.equal(h.headers('https://local.example').has('x-dsh-model-grant'), false)
  h.idle()
  assert.equal(h.step([], 2, 'public'), 'allowed')
  assert.equal(h.gateway.requiresPersonalGrant('mock-session'), false)
})

test('remote calls with absent, malformed, expired or mismatched grants fail without local fallback', async () => {
  for (const make of [() => undefined, () => 'invalid', h => h.envelope({ expiresAt: 999 }),
    h => h.envelope({ session: 'other-session' }), h => h.envelope({ request: 'other-request' })]) {
    const h = harness(), grant = make(h)
    await assert.rejects(h.connection({ 'x-dsh-model-remote': '1', ...(grant ? { 'x-dsh-model-grant': grant } : {}) }, async () => {
      assert.throws(() => h.route())
      return h.prompt()
    }), /授权/)
  }
})

test('a remote turn uses only its grant and an idle session can be used locally again', async () => {
  const h = harness(), value = h.envelope()
  await h.connection({ 'x-dsh-model-grant': value }, () => h.prompt())
  assert.equal(h.step(), 'allowed')
  assert.deepEqual(h.route(), { baseURL: 'https://gateway.example/api/model-gateway/personal', apiKey: 'gateway', headers: { Authorization: 'Bearer gateway' } })
  assert.equal(h.headers().get('x-dsh-model-grant'), value)
  assert.equal(h.headers().get('x-dsh-model-session'), 'mock-session')
  assert.throws(() => h.headers('https://local.example'), /授权/)
  assert.throws(() => h.route('public'), /授权/)
  await assert.rejects(h.connection({}, () => h.prompt()), /另一位/)
  h.idle()
  assert.deepEqual(h.step([], 2), { kind: 'reject' })
  await h.connection({}, () => h.prompt('public', 'local-request'))
  assert.equal(h.step([{ source: { kind: 'user', rpcId: 'local-request' } }], 3, 'public'), 'allowed')
  assert.equal(h.route(), undefined)
})

test('authorization cannot cross users, turns, or its expiry', async () => {
  const h = harness()
  await h.connection({ 'x-dsh-model-grant': h.envelope() }, () => h.prompt())
  assert.equal(h.step(), 'allowed')
  assert.equal(h.step([], 1), 'allowed')
  await assert.rejects(h.connection({ 'x-dsh-model-grant': h.envelope({ user: 'other-user', request: 'other-request' }) },
    () => h.prompt('personal', 'other-request')), /另一位/)
  h.expire()
  assert.throws(() => h.route(), /授权/)
  assert.deepEqual(h.step([], 1), { kind: 'reject' })
  assert.deepEqual(h.step([], 2), { kind: 'reject' })
})

test('remote public routes stay unavailable and explicit exclusive mode still requires a grant locally', async () => {
  const h = harness()
  await assert.rejects(h.connection({ 'x-dsh-model-grant': h.envelope() }, () => h.prompt('public')), /个人 Provider/)
  const exclusive = harness(false)
  await assert.rejects(exclusive.connection({}, () => exclusive.prompt()), /授权/)
})
