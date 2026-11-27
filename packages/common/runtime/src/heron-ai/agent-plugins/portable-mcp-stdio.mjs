import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'

const lifetime = new AbortController()
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const isRequest = message => message?.method && Object.hasOwn(message, 'id')
const isResponse = message => message && !message.method && Object.hasOwn(message, 'id')

// This file runs from the exported ZIP and uses only the Node standard library.
async function* messages(response) {
  if (response.status === 202 || response.status === 204) return
  const type = response.headers.get('content-type')?.split(';', 1)[0].toLowerCase()
  if (type === 'application/json') {
    const data = await response.json()
    yield* Array.isArray(data) ? data : [data]
    return
  }
  if (type !== 'text/event-stream' || !response.body) {
    await response.body?.cancel()
    throw Error('Unexpected upstream MCP response')
  }
  const stream = Readable.fromWeb(response.body)
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let data = []
  try {
    for await (const line of lines) {
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      if (line || !data.length) continue
      const event = data.join('\n')
      data = []
      if (!event) continue
      const message = JSON.parse(event)
      yield* Array.isArray(message) ? message : [message]
    }
  } finally {
    lines.close()
    stream.destroy()
  }
}

async function relay(server) {
  let session
  let protocolVersion

  async function request(method, { payload, signal = lifetime.signal } = {}) {
    const headers = new Headers(server.headers)
    headers.set('Accept', method === 'GET' ? 'text/event-stream' : 'application/json, text/event-stream')
    if (payload !== undefined) headers.set('Content-Type', 'application/json')
    if (session) headers.set('Mcp-Session-Id', session)
    if (protocolVersion) headers.set('MCP-Protocol-Version', protocolVersion)
    return fetch(server.url, {
      method, headers, signal, redirect: 'manual',
      body: payload === undefined ? undefined : JSON.stringify(payload),
    })
  }

  async function post(payload) {
    const batch = Array.isArray(payload) ? payload : [payload]
    const pending = new Map(batch.filter(isRequest).map(message => [message.id, message.method]))
    let failure = 'Upstream MCP did not complete the request'
    try {
      const response = await request('POST', { payload })
      if (!response.ok) {
        await response.body?.cancel()
        failure = 'Upstream MCP returned HTTP ' + response.status
      } else {
        for await (const message of messages(response)) {
          if (isResponse(message) && pending.get(message.id) === 'initialize' && message.result) {
            session = response.headers.get('mcp-session-id')
            protocolVersion = message.result.protocolVersion
          }
          send(message)
          if (isResponse(message)) pending.delete(message.id)
          if (!pending.size) break
        }
      }
    } catch {
      failure = 'Upstream MCP transport failed'
    }
    if (!lifetime.signal.aborted) {
      for (const id of pending.keys()) send({ jsonrpc: '2.0', id, error: { code: -32000, message: failure } })
    }
  }

  async function listen() {
    try {
      const response = await request('GET')
      if (!response.ok) {
        await response.body?.cancel()
        return
      }
      for await (const message of messages(response)) send(message)
    } catch {
      // An optional server-initiated stream may close at any time.
    }
  }

  try {
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      if (!line.trim()) continue
      const payload = JSON.parse(line)
      if (payload.method === 'initialize') {
        await post(payload)
      } else if (payload.method === 'notifications/initialized') {
        await post(payload)
        void listen()
      } else {
        void post(payload)
      }
    }
  } finally {
    lifetime.abort()
    if (session) {
      try {
        const response = await request('DELETE', { signal: AbortSignal.timeout(2000) })
        await response.body?.cancel()
      } catch {
        // The server can expire the session or decline explicit termination.
      }
    }
  }
}

try {
  const config = JSON.parse(await readFile(new URL('./portable-mcp-servers.json', import.meta.url), 'utf8'))
  const id = process.argv[2]
  if (!Object.hasOwn(config, id)) throw Error('Unknown MCP server')
  await relay(config[id])
} catch {
  console.error('Could not run the bundled MCP transport.')
  process.exitCode = 1
}
