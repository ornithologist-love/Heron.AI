// Anchor: Docs/architecture/extensions.md#身份与模型通道集成
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../web.mjs'

test('a search-only backend serves its own model route until disposed', async () => {
  const sessions = new AsyncLocalStorage()
  const ctx = new Context()
  ctx.provide('agents', {
    currentInitiator: () => ({ session: { requestContext: () => ({ provider: sessions.getStore() }) } }),
  })
  apply(ctx, {
    searchProvider: { get: () => 'deepseek-official' },
    fetchProvider: { get: () => 'http' },
  })
  const searchBackend = id => ({
    id,
    available: () => true,
    async search({ query }) {
      return { content: `${id}: ${query}`, sources: [], truncated: false }
    },
  })
  ctx.web.registerSearchProvider(searchBackend('deepseek-official'))
  ctx.web.registerFetchProvider({
    id: 'http',
    available: () => true,
    async fetch({ url }) {
      return { url, statusCode: 200, body: { kind: 'text', content: 'mock page' }, truncated: false }
    },
  })
  const dispose = ctx.providerWeb.register('mock-chat', searchBackend('mock-search'))

  const search = provider => sessions.run(provider, async () => {
    await Promise.resolve()
    return ctx.web.search({ query: 'fixture', llmProvider: provider })
  })
  const [personal, deepseek] = await Promise.all([search('mock-chat'), search('deepseek-official')])
  assert.equal(personal.content, 'mock-search: fixture')
  assert.equal(deepseek.content, 'deepseek-official: fixture')
  assert.ok(ctx.web.listProviders().search.some(provider => provider.id === 'mock-search'))
  assert.deepEqual(ctx.web.listProviders().fetch.map(provider => provider.id), ['http'])

  const fetchPage = provider => sessions.run(provider, () => ctx.web.fetch({ url: 'https://example.test/' }))
  assert.equal((await fetchPage('deepseek-official')).body.content, 'mock page')
  await assert.rejects(fetchPage('mock-chat'), { code: 'WEB_PROVIDER_UNAVAILABLE' })

  dispose()
  assert.ok(!ctx.web.listProviders().search.some(provider => provider.id === 'mock-search'))
  await assert.rejects(search('mock-chat'), { code: 'WEB_PROVIDER_UNAVAILABLE' })
  assert.equal((await search('deepseek-official')).content, 'deepseek-official: fixture')
})
