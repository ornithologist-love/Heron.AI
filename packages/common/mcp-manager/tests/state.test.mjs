// Anchor: Docs/architecture/extensions.md#插件声明连接器
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectorOverview, deriveConnectorState, filterCustomServers } from '../src/client/state.ts'

test('the Connectors overview switches between Connectors and Skills when the skills slot exists', () => {
  assert.deepEqual(connectorOverview('connectors', true, null), { showTabs: true, activeTab: 'connectors' })
  assert.deepEqual(connectorOverview('skills', true, null), { showTabs: true, activeTab: 'skills' })
})

test('the Connectors overview hides tabs without a skills contribution and in connector details', () => {
  assert.deepEqual(connectorOverview('skills', false, null), { showTabs: false, activeTab: 'connectors' })
  assert.deepEqual(connectorOverview('connectors', true, 'fixture-connector'), { showTabs: false, activeTab: 'connectors' })
})

test('deriveConnectorState maps raw server states into 4 states with 1 primary action', () => {
  assert.deepEqual(
    deriveConnectorState({ serverName: 'linear-connector', enabled: false, status: 'disabled', authType: 'oauth', authorized: false }, false, false),
    { tone: 'disconnected', action: 'connect', statusKey: 'disconnected' },
  )
  assert.deepEqual(
    deriveConnectorState({ serverName: 'linear-connector', enabled: true, status: 'connecting', authType: 'oauth' }, false, false),
    { tone: 'connecting', action: 'cancel', statusKey: 'connecting' },
  )
  assert.deepEqual(
    deriveConnectorState({ serverName: 'linear-connector', enabled: true, status: 'error', authType: 'oauth' }, false, true),
    { tone: 'connecting', action: 'cancel', statusKey: 'connectorWaiting' },
  )
  assert.deepEqual(
    deriveConnectorState({ serverName: 'linear-connector', enabled: true, status: 'connected', authType: 'oauth', authorized: true }, false, false),
    { tone: 'connected', action: 'toggle', statusKey: 'connectorConnected' },
  )
  assert.deepEqual(
    deriveConnectorState({ serverName: 'notion-connector', enabled: true, status: 'error', authType: 'oauth', authorized: false }, false, false),
    { tone: 'error', action: 'retry', statusKey: 'error' },
  )
})

test('filterCustomServers excludes entries with connectorPresentation', () => {
  const custom = filterCustomServers([
    { serverName: 'linear-connector', connectorPresentation: { title: 'Linear' } },
    { serverName: 'my-local-mcp' },
    { serverName: 'iWiki', connectorPresentation: { title: 'iWiki' } },
  ])
  assert.deepEqual(custom.map(s => s.serverName), ['my-local-mcp'])
})
