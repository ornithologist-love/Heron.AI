// Anchor: Docs/architecture/HOST-INTEGRATION.md#H2.1 参数白名单（严格）
// The launch arguments are a strict whitelist: anything unknown or malformed stops the start
// instead of being ignored, and relative paths in --config resolve against that file.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { launchOptions } from '../launch.mjs'

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'heron-ai-launch-'))

test('unknown, positional and value-less arguments are rejected, not ignored', () => {
  for (const argv of [['--not-an-option', 'x'], ['state-dir', 'x'], ['--state-dir'], ['--port', '0', '--workspace']])
    assert.throws(() => launchOptions(argv), /Invalid AIHost launch arguments/, argv.join(' '))
})

test('every documented argument is accepted', () => {
  const root = temp()
  const options = launchOptions([
    '--state-dir', root, '--local-root', root, '--ready-file', path.join(root, 'ready.json'),
    '--workspace', root, '--port', '0', '--host-theme', 'dark', '--credential-root', root,
    '--identity-file', path.join(root, 'id.json'), '--skills-dir', root, '--templates-dir', root,
    '--mcp-config', path.join(root, 'mcp.json'), '--static-root', root, '--dev-origin', 'http://127.0.0.1:1',
    '--token', '0123456789abcdef', '--host-edition', 'user', '--server-url', 'http://127.0.0.1:9',
    '--reserved-mcp-endpoint', 'http://127.0.0.1:9/mcp'])
  assert.equal(options.stateDir, root)
})

test('relative paths in --config resolve against the config file directory', () => {
  const root = temp()
  const nested = path.join(root, 'nested')
  fs.mkdirSync(nested)
  const config = path.join(nested, 'host.json')
  fs.writeFileSync(config, JSON.stringify({ stateDir: 'state', localRoot: '../local' }))
  const options = launchOptions(['--config', config, '--workspace', 'work'])
  assert.equal(options.stateDir, path.join(nested, 'state'))
  assert.equal(options.localRoot, path.join(root, 'local'))
  assert.equal(options.workspace, path.join(nested, 'work'))
})

test('the host control token must be 16-128 lowercase hex characters', () => {
  for (const token of ['0123456789abcde', '0123456789ABCDEF', 'g123456789abcdef', 'a'.repeat(129)])
    assert.throws(() => launchOptions(['--token', token]), /Invalid shell token/, token)
  assert.doesNotThrow(() => launchOptions(['--token', 'a'.repeat(128)]))
})

test('ports outside 0-65535 and non-integers are rejected', () => {
  for (const port of ['-1', '65536', '1.5', 'http'])
    assert.throws(() => launchOptions(['--port', port]), /Invalid AIHost port/, port)
})

test('reserved MCP endpoints accumulate and must be plain http(s) URLs without credentials', () => {
  const root = temp()
  const config = path.join(root, 'host.json')
  fs.writeFileSync(config, JSON.stringify({ reservedMcpEndpoints: ['http://127.0.0.1:1/a'] }))
  const options = launchOptions(['--config', config, '--reserved-mcp-endpoint', 'http://localhost:2/b',
    '--reserved-mcp-endpoint', 'https://[::1]:3/c'])
  assert.deepEqual(options.reservedMcpEndpoints, ['http://127.0.0.1:1/a', 'http://localhost:2/b', 'https://[::1]:3/c'])
  for (const endpoint of ['ftp://127.0.0.1:1/', 'http://user:secret@127.0.0.1:1/', 'not a url'])
    assert.throws(() => launchOptions(['--reserved-mcp-endpoint', endpoint]), /Invalid reserved MCP endpoint/, endpoint)
})
