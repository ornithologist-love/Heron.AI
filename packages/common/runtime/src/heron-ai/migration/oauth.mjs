import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { digest, readJson } from './files.mjs'

async function oldCredentialReader(options) {
  if (!options.localRoot) return null
  const versions = path.join(options.localRoot,'ksf_ai','versions')
  let folders
  try { folders = await fs.readdir(versions,{ withFileTypes:true }) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
  for (const folder of folders.filter(folder => folder.isDirectory()).reverse()) {
    const root = path.join(versions,folder.name,'AiHost','node_modules','pi-mcp-adapter')
    const manifest = await readJson(path.join(root,'package.json'))
    // This pinned inspector reads the OS credential store with migrateLegacy:
    // false. Never invoke its importing getter, which removes old plaintext.
    if (manifest?.version !== '2.34.0') continue
    const prefix = pathToFileURL(root + path.sep).href
    const hook = registerHooks({ load(url,context,next) {
      if (url.startsWith(prefix) && url.endsWith('.ts')) return { format:'module',shortCircuit:true,
        source:stripTypeScriptTypes(readFileSync(fileURLToPath(url),'utf8'),{ mode:'transform' }) }
      return next(url,context)
    } })
    try {
      const oauth = await import(pathToFileURL(path.join(root,'mcp-auth.ts')).href)
      const bearer = await import(pathToFileURL(path.join(root,'mcp-bearer-store.ts')).href)
      return { inspectOAuth:oauth.inspectAuthForUrl,getBearer:bearer.getBearerTokenForUrl }
    }
    catch { /* A removed old payload or unsupported native reader needs login. */ }
    finally { hook.deregister() }
  }
  return null
}

export async function migrateOAuth(options,servers,report) {
  report.oauth = 0; report.oauthNeedsLogin = 0; report.bearer = 0; report.bearerNeedsLogin = 0
  const pending = servers.filter(server => server.authType === 'oauth' && !server.oauth?.tokens?.accessToken)
  const pendingBearer = servers.filter(server => server.legacy?.config.auth === 'bearer'
    && !server.legacy.config.bearerTokenEnv && !server.headers?.Authorization)
  if (!pending.length && !pendingBearer.length) return
  const reader = await oldCredentialReader(options)
  for (const server of pendingBearer) {
    let token
    // The pinned bearer getter only reads the exact-URL OS record. It neither
    // migrates plaintext nor modifies/deletes the old credential.
    try { token = reader?.getBearer(server.legacy.name,server.url) } catch {}
    if (token) {
      server.headers = { ...server.headers,Authorization:'Bearer ' + token }
      server.legacy.baseline.headers = { ...server.headers }
      report.bearer++
    } else report.bearerNeedsLogin++
  }
  // Former runtimes kept MCP OAuth state per model channel under provider-runtime/<channel>.
  const channels = await fs.readdir(path.join(options.stateDir,'provider-runtime'),{ withFileTypes:true })
    .then(entries => entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort(),() => [])
  for (const server of pending) {
    let entry
    for (const provider of channels) {
      const baseDir = path.join(options.stateDir,'provider-runtime',provider,'pi','mcp-oauth')
      if (reader) {
        const result = reader.inspectOAuth(server.legacy?.name ?? server.serverName,server.url,{ baseDir })
        if (result.status === 'present') entry = result.entry
      }
      entry ??= await readJson(path.join(baseDir,'sha256-' + digest(server.legacy?.name ?? server.serverName),'tokens.json'))
      if (entry?.serverUrl === server.url && entry.tokens?.accessToken && entry.clientInfo?.clientId) break
      entry = undefined
    }
    if (!entry || server.oauth?.clientId && server.oauth.clientId !== entry.clientInfo.clientId) {
      report.oauthNeedsLogin++; continue
    }
    server.oauth = { ...server.oauth, clientId:entry.clientInfo.clientId,
      ...(entry.clientInfo.clientSecret ? { clientSecret:entry.clientInfo.clientSecret } : {}),
      ...(entry.tokens.issuer ? { authorizationServerUrl:entry.tokens.issuer } : {}),
      tokens:{ accessToken:entry.tokens.accessToken,tokenType:'Bearer',
        ...(entry.tokens.refreshToken ? { refreshToken:entry.tokens.refreshToken } : {}),
        ...(entry.tokens.expiresAt !== undefined ? { expiresAt:entry.tokens.expiresAt * 1000 } : {}),
        ...(entry.tokens.scope ? { scope:entry.tokens.scope } : {}) } }
    report.oauth++
  }
}
