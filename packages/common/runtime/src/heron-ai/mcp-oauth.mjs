import { registerClient } from '@modelcontextprotocol/sdk/client/auth.js'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

// Only hosts that implement this private stdio capability receive authorization URLs.
// Keep them out of diagnostics and route replies by a per-request random identifier.
function openInNativeHost(url) {
  return new Promise((resolve, reject) => {
    const id = randomUUID()
    let buffer = '', settled = false
    const finish = (error, mode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.stdin.off('data', receive)
      process.stdin.off('end', disconnected)
      process.stdin.off('error', disconnected)
      error ? reject(error) : resolve(mode)
    }
    const disconnected = () => finish(new Error('授权浏览器宿主已断开。'))
    const receive = chunk => {
      buffer += chunk.toString('utf8')
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message?.type !== 'external-browser-result' || message.id !== id) continue
        if (!message.ok || !['system', 'webview'].includes(message.mode))
          finish(new Error('无法打开授权页面，请查看 AI 调试日志。'))
        else finish(null, message.mode)
      }
      if (buffer.length > 65536) finish(new Error('授权浏览器宿主响应无效。'))
    }
    const timer = setTimeout(() => finish(new Error('等待授权浏览器宿主响应超时。')), 20000)
    timer.unref()
    process.stdin.on('data', receive)
    process.stdin.once('end', disconnected)
    process.stdin.once('error', disconnected)
    process.stdout.write(JSON.stringify({ event: 'external-browser-request', id, url: url.href }) + '\n',
      error => { if (error) disconnected() })
  })
}

// Native hosts can recover a failed system-browser launch in their own WebView.
// Other hosts retain the system opener without depending on page popup support.
export async function openAuthorizationUrl(url) {
  if (process.platform !== 'win32' || url.protocol !== 'https:')
    throw new Error('无法打开授权页面：授权地址必须使用 HTTPS。')
  if (process.env.DSH_EXTERNAL_BROWSER_BRIDGE === 'stdio-v1') {
    process.stderr.write('[MCP-BROWSER] phase=host-browser-requested\n')
    const mode = await openInNativeHost(url)
    process.stderr.write(`[MCP-BROWSER] phase=host-browser-opened mode=${mode}\n`)
    return
  }
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const diagnostic = detail => process.stderr.write(`[MCP-BROWSER] ${detail}\n`)
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'rundll32.exe')
    diagnostic('phase=launcher-start launcher=rundll32 scheme=https')
    const child = spawn(executable, ['url.dll,FileProtocolHandler', url.href], { stdio: 'ignore', windowsHide: true, shell: false })
    child.on('spawn', () => diagnostic(`phase=launcher-spawned pid=${child.pid}`))
    child.on('error', error => {
      diagnostic(`phase=launcher-failed errorCode=${/^E[A-Z0-9_]{1,40}$/.test(error.code ?? '') ? error.code : 'unknown'} elapsedMs=${Date.now() - started}`)
      reject(new Error('无法启动授权浏览器，请重试。'))
    })
    child.on('close', (code, signal) => {
      // A successful shell handoff is not proof that a browser window or callback appeared.
      diagnostic(`phase=launcher-exited exitCode=${code ?? 'none'} signalled=${Boolean(signal)} elapsedMs=${Date.now() - started}`)
      code === 0 ? resolve() : reject(new Error('无法打开授权页面，请重试。'))
    })
  })
}

// dsh-mcp-manager implements PKCE, exchange, token storage and reconnect, and
// asks for registration whenever no saved client is bound to this redirect URI
// (the sidecar port is chosen per launch). Use the MCP SDK for public-client DCR.
export async function prepareOAuthClient(client, discovery, redirectUri, configured) {
  if (configured) return { registered: false }
  if (!discovery.authorizationServerMetadata?.registration_endpoint) {
    throw new Error('此 OAuth 服务需要先在服务器编辑页填写 Client ID')
  }
  const registered = await registerClient(discovery.authorizationServerUrl, {
    metadata: discovery.authorizationServerMetadata,
    clientMetadata: {
      client_name: 'HeronAI DeepSeek Harness',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
  })
  client.client_id = registered.client_id
  client.client_secret = registered.client_secret
  return { registered: true }
}
