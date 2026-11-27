// Anchor: Docs/architecture/extensions.md
// Run with HERON_AGENT_PLUGIN_HOST set to the assembled AiHost directory.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { MCP_SCHEMA, PLUGIN_SCHEMA } from '../agent-plugins/manifest.mjs'

const mockServer = `
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'

assert.equal(process.cwd(), process.env.PLUGIN_ROOT)
assert.equal(path.normalize(process.argv[2]), path.join(process.env.PLUGIN_DATA, 'fixture-state'))
fs.appendFileSync(process.argv[2], String(process.pid) + '\\n')
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  if (!Object.hasOwn(request, 'id')) continue
  let result = {}
  if (request.method === 'initialize') {
    result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
  } else if (request.method === 'tools/list') {
    result = { tools: [{ name: 'fixture_echo', description: 'Test tool', inputSchema: { type: 'object' } }] }
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
}
`

const loopbackOnly = `
const nativeFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return nativeFetch(request)
  return Response.json({ error: 'Fixture only permits local HTTP requests' }, { status: 503 })
}
`

async function eventually(check, failure) {
  const deadline = Date.now() + 12_000
  do {
    if (await check()) return
    await delay(100)
  } while (Date.now() < deadline)
  assert.fail(failure)
}

const host = process.env.HERON_AGENT_PLUGIN_HOST
test('assembled AiHost mounts and unmounts a standard local plugin via the browser owner API', { skip: !host }, async t => {
  const parent = await realpath(os.tmpdir())
  const root = await mkdtemp(path.join(parent, 'heron-agent-plugin-e2e-'))
  t.after(async () => {
    const target = await realpath(root)
    assert.equal(path.dirname(target), parent)
    assert.ok(path.basename(target).startsWith('heron-agent-plugin-e2e-'))
    await rm(target, { recursive: true, force: true })
  })
  const packageName = 'fixture-agent-plugin'
  const skillName = 'fixture-agent-skill'
  const discoveredName = 'fixture-discovered-plugin'
  const directory = path.join(root, 'package')
  const stateDir = path.join(root, 'state')
  const home = path.join(stateDir, 'dsh')
  const discoveredDirectory = path.join(home, 'agent-plugins', discoveredName)
  const processLog = path.join(home, 'agent-plugin-data', packageName, 'fixture-state')
  const script = path.join(directory, 'fixture.mjs')
  const skillDirectory = path.join(directory, 'skills', skillName)
  const configFile = path.join(root, 'host.json')
  const defaultsFile = path.join(root, 'defaults.json')
  const preloadFile = path.join(root, 'loopback-only.mjs')
  const manifestFile = path.join(directory, 'plugin.json')
  const writeJson = (file, value) => writeFile(file, JSON.stringify(value))
  await Promise.all([mkdir(skillDirectory, { recursive: true }), mkdir(discoveredDirectory, { recursive: true })])
  await Promise.all([
    writeJson(manifestFile, { $schema: PLUGIN_SCHEMA, name: packageName }),
    writeJson(path.join(discoveredDirectory, 'plugin.json'), { $schema: PLUGIN_SCHEMA, name: discoveredName }),
    writeJson(path.join(directory, 'mcp.json'), { $schema: MCP_SCHEMA, mcpServers: {
      fixture: { type: 'stdio', command: path.basename(process.execPath),
        args: ['${PLUGIN_ROOT}/fixture.mjs', '${PLUGIN_DATA}/fixture-state'] },
    } }),
    writeFile(script, mockServer),
    writeFile(path.join(skillDirectory, 'SKILL.md'), [
      '---', `name: ${skillName}`, 'description: Fixture skill', 'disable-model-invocation: true', '---', 'Fixture body',
    ].join('\n')),
    writeJson(configFile, { stateDir, includeUserSkillRoots: false, mcpConfigFile: defaultsFile }),
    writeJson(defaultsFile, { version: '1', mcpServers: {} }),
    writeFile(preloadFile, loopbackOnly),
  ])

  const child = spawn(process.execPath, ['--import', pathToFileURL(preloadFile).href,
    path.join(host, 'main.mjs'), '--config', configFile], {
    cwd: host, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const ready = Promise.withResolvers()
  const closed = new Promise(resolve => child.once('close', resolve))
  const diagnostics = []
  const remember = line => {
    diagnostics.push(line.replace(/https?:\/\/\S+|Bearer\s+\S+/gi, '[filtered]'))
    if (diagnostics.length > 30) diagnostics.shift()
  }
  createInterface({ input: child.stderr }).on('line', remember)
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const event = JSON.parse(line)
      if (event.event === 'ready') ready.resolve(event.url)
    } catch { remember(line) }
  })
  child.once('exit', code => ready.reject(Error(`AiHost exited before ready with code ${code}`)))
  child.once('error', ready.reject)

  try {
    const readyUrl = await Promise.race([
      ready.promise, delay(40_000, undefined, { ref: false }).then(() => assert.fail('AiHost did not become ready')),
    ])
    const login = await fetch(readyUrl, { redirect: 'manual' })
    assert.equal(login.status, 303)
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]
    assert.ok(cookie, 'Browser owner login returns a cookie')
    async function request(url, body, extraHeaders = {}, expectedStatus = 200) {
      const response = await fetch(new URL(url, readyUrl), {
        method: body === undefined ? 'GET' : 'POST',
        headers: { cookie, 'content-type': 'application/json', ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      })
      const responseText = await response.text()
      assert.equal(response.status, expectedStatus, `${url}: ${responseText.slice(0, 350)}`)
      const result = JSON.parse(responseText)
      return result
    }
    const api = '/mcp-manager/api'
    const pluginApi = `${api}/agent-plugins`
    const plugin = async () => (await request(pluginApi)).plugins.find(item => item.id === packageName)
    const connector = async () => (await request(`${api}/connectors`)).servers.find(item => item.connectorPresentation?.id === packageName)
    const skill = async () => {
      const method = 'skill-manager/list'
      const response = await request(`/api/${method}`, { type: 'client-request', rpcId: 'fixture', method, payload: {} })
      assert.equal(response.result.ok, true, response.result.error?.message)
      return response.result.value.skills.find(item => item.name === skillName)
    }

    const initial = await request(pluginApi)
    assert.equal(initial.canManage, true)
    for (const id of ['linear-connector', 'notion-connector']) {
      assert.equal(initial.plugins.find(item => item.id === id)?.enabled, true)
    }
    assert.equal(initial.plugins.find(item => item.id === discoveredName)?.enabled, true)
    const exportPath = pluginApi + '/export'
    const requestExport = id => fetch(new URL(exportPath, readyUrl), {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ id }), signal: AbortSignal.timeout(8000),
    })
    await request(exportPath, { id: discoveredName }, { 'x-dsh-model-remote': 'true' }, 403)
    await request(exportPath, { id: discoveredDirectory }, {}, 404)
    await request(exportPath, { id: discoveredName, format: 'invalid' }, {}, 400)
    const archive = await requestExport(discoveredName)
    assert.equal(archive.status, 200, 'The browser owner can download an installed plugin')
    assert.equal(archive.headers.get('content-type'), 'application/zip')
    assert.equal(archive.headers.get('cache-control'), 'no-store')
    assert.match(archive.headers.get('content-disposition') ?? '', /^attachment; filename="fixture-discovered-plugin(?:-standard)?\.zip"$/)
    const archiveBytes = Buffer.from(await archive.arrayBuffer())
    assert.equal(Number(archive.headers.get('content-length')), archiveBytes.length)
    assert.deepEqual([...archiveBytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04])
    await request(pluginApi + '/preview', { directory }, { 'x-dsh-model-remote': 'true' }, 403)
    assert.equal(await plugin(), undefined)
    const { preview } = await request(pluginApi + '/preview', { directory })
    assert.deepEqual(preview.servers, [{
      id: 'fixture', command: path.basename(process.execPath),
      args: ['${PLUGIN_ROOT}/fixture.mjs', '${PLUGIN_DATA}/fixture-state'],
    }])
    const commit = { id: preview.id, serverIds: ['fixture'], skillNames: [skillName], allowStdio: false }
    await request(pluginApi + '/commit', commit, {}, 400)
    assert.equal(await plugin(), undefined)
    await assert.rejects(readFile(processLog, 'utf8'), { code: 'ENOENT' })
    await request(pluginApi + '/commit', { ...commit, allowStdio: true })
    assert.deepEqual((await plugin()).connectorIds, [packageName])
    await eventually(async () => (await connector())?.toolNames.includes('fixture_echo'), 'Imported stdio tool was not discovered')
    assert.equal((await skill()).modelInvocable, false)
    const serverPid = async () => Number((await readFile(processLog, 'utf8')).trim().split('\n').at(-1))
    const running = pid => {
      try { process.kill(pid, 0); return true }
      catch (error) { if (error.code === 'ESRCH') return false; throw error }
    }
    const initialPid = await serverPid()
    assert.ok(Number.isInteger(initialPid) && initialPid > 0 && running(initialPid))

    await request(`${pluginApi}/toggle`, { id: packageName, enabled: false })
    assert.equal((await plugin()).enabled, false)
    await eventually(async () => !(await connector())?.toolNames.includes('fixture_echo'), 'Disabled stdio tool remained active')
    await eventually(() => !running(initialPid), 'Disabled stdio process remained alive')
    assert.equal(await skill(), undefined)

    await request(`${pluginApi}/toggle`, { id: packageName, enabled: true })
    await eventually(async () => (await connector())?.toolNames.includes('fixture_echo'), 'Reenabled stdio tool was not discovered')
    assert.equal((await skill()).modelInvocable, false)
    const reenabledPid = await serverPid()
    assert.ok(Number.isInteger(reenabledPid) && reenabledPid > 0 && running(reenabledPid))

    await request(`${pluginApi}/remove`, { id: packageName })
    assert.equal(await plugin(), undefined)
    assert.equal(await connector(), undefined)
    assert.equal(await skill(), undefined)
    await eventually(() => !running(reenabledPid), 'Removed stdio process remained alive')
    assert.equal(JSON.parse(await readFile(manifestFile, 'utf8')).name, packageName)
    await assert.rejects(readFile(path.join(home, 'agent-plugins', packageName, 'plugin.json'), 'utf8'), { code: 'ENOENT' })
  } catch (error) {
    t.diagnostic(diagnostics.join('\n'))
    throw error
  } finally {
    child.stdin.end()
    const exited = await Promise.race([closed.then(() => true), delay(3_000, false, { ref: false })])
    if (!exited) child.kill()
    await closed
  }
})
