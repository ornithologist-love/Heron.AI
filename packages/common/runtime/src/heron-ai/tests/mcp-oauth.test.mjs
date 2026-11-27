// Anchor: Docs/architecture/extensions.md#google-connector
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { openAuthorizationUrl } from '../mcp-oauth.mjs'

test('external-only authorization uses the Windows shell with the native bridge enabled', {
  skip: process.platform !== 'win32',
}, async t => {
  const previousBridge = process.env.DSH_EXTERNAL_BROWSER_BRIDGE
  process.env.DSH_EXTERNAL_BROWSER_BRIDGE = 'stdio-v1'
  const launcher = t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter()
    child.pid = 123
    queueMicrotask(() => child.emit('close', 0, null))
    return child
  })
  syncBuiltinESMExports()
  t.after(() => {
    if (previousBridge === undefined) delete process.env.DSH_EXTERNAL_BROWSER_BRIDGE
    else process.env.DSH_EXTERNAL_BROWSER_BRIDGE = previousBridge
    launcher.mock.restore()
    syncBuiltinESMExports()
  })

  const url = new URL('https://oauth.example.test/authorize')
  const result = openAuthorizationUrl(url, { systemOnly: true })
  assert.equal(launcher.mock.callCount(), 1)
  const [executable, args] = launcher.mock.calls[0].arguments
  assert.equal(path.basename(executable), 'rundll32.exe')
  assert.deepEqual(args, ['url.dll,FileProtocolHandler', url.href])
  await result
})
