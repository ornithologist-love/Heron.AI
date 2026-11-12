import { publicStatus } from './acp/providers.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { ai_provider_definitions } from './acp/runtime/providers.mjs'

export const inject = ['webServer', 'connection', 'heronAiAcp', 'credentials', 'sessionController', 'agents', 'heronAiAgents', 'heronAiSessionChoices']

export async function apply(ctx) {
  const registry = ctx.heronAiAcp.registry
  const nativeCredential = credentialRef('DEEPSEEK_API_KEY')
  const definitionFor = id => registry.definition(id) ?? (id === 'deepseek-official' ? {
    id, name: 'DeepSeek', credential: { label: 'DeepSeek Token', placeholder: 'sk-…',
      help_url: 'https://platform.deepseek.com/api_keys', help_label: 'DeepSeek API Keys' },
  } : undefined)
  const configured = id => id === 'deepseek-official'
    ? ctx.credentials.describe(nativeCredential).then(value => value.configured)
    : ctx.heronAiAcp.credentialConfigured(id)
  async function handler(req, res) {
    const reply = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    if (ctx.connection.requestRejection(req)) { reply(403, { error: 'Request not authorized' }); return }
    const url = new URL(req.url, 'http://127.0.0.1')
    try {
      if (url.pathname === '/heron-ai-acp/model-gateway' && req.method === 'GET')
        return reply(200, { enabled: !!ctx.heronAiAcp.modelGateway })
      if (ctx.heronAiAcp.modelGateway && ['/heron-ai-acp/providers', '/heron-ai-acp/credentials', '/heron-ai-acp/settings', '/heron-ai-acp/public'].includes(url.pathname))
        return reply(403, { error: '请从统一登录网页入口管理个人 Provider。' })
      if (req.method === 'GET' && url.pathname.startsWith('/heron-ai-acp/ui/')) {
        const root = path.join(ctx.heronAiAcp.options.hostRoot, 'heron-ai', 'ui')
        const file = path.resolve(root, decodeURIComponent(url.pathname.slice('/heron-ai-acp/ui/'.length)))
        if (!file.startsWith(root + path.sep) || !['.js', '.css', '.png', '.svg', '.ico', '.woff', '.woff2'].includes(path.extname(file))) throw new Error('Unknown widget asset')
        const bytes = await fs.readFile(file)
        res.writeHead(200, { 'Content-Type': ({ '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' })[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' })
        res.end(bytes); return
      }
      let body = {}
      if (req.method !== 'GET') {
        let data = ''
        for await (const chunk of req) { data += chunk; if (Buffer.byteLength(data) > 32768) throw new Error('Request too large') }
        body = JSON.parse(data)
      }
      if (url.pathname === '/heron-ai-acp/providers' && req.method === 'GET') {
        await registry.refresh()
        const providers = await Promise.all(registry.statusList().map(async item => ({ ...publicStatus(item),
          credential_configured: registry.definition(item.id)?.credential || registry.definition(item.id)?.public ? await ctx.heronAiAcp.credentialConfigured(item.id) : false,
          ...(registry.definition(item.id)?.public ? { public: true, allowance: await ctx.heronAiAcp.providerStatus(item.id) } : {}),
          capabilities: ctx.heronAiAcp.provider_capabilities(item.id), credential: registry.definition(item.id)?.credential,
          credentialIssue: ctx.heronAiAcp.credentialIssues.get(item.id) })))
        return reply(200, { providers, catalog: registry.directory.status(), anyCredentialConfigured: providers.some(item => item.credential && item.credential_configured)
          || await configured('deepseek-official') })
      }
      if (url.pathname === '/heron-ai-acp/public' && req.method === 'GET')
        return reply(200, await ctx.heronAiAcp.providerStatus(url.searchParams.get('provider')
          ?? ai_provider_definitions.find(item => item.public)?.id))
      if (url.pathname === '/heron-ai-acp/credentials' && req.method === 'GET') {
        const id = url.searchParams.get('provider'), definition = definitionFor(id)
        if (!definition?.credential) throw new Error('This provider does not use a local Token')
        return reply(200, { id, name: definition.name, credential: definition.credential,
          credential_configured: await configured(id), credentialIssue: ctx.heronAiAcp.credentialIssues.get(id) })
      }
      if (url.pathname === '/heron-ai-acp/settings' && req.method === 'PUT') {
        const definition = definitionFor(body.provider)
        if (!definition?.credential || typeof body.token !== 'string' || !body.token.trim()) throw new Error('Provider token is required')
        if (body.provider === 'deepseek-official') await ctx.credentials.set(nativeCredential, body.token.trim())
        else await ctx.heronAiAcp.saveToken(body.provider, body.token.trim())
        return reply(200, { saved: true })
      }
      if (url.pathname === '/heron-ai-acp/session') {
        const sessionId = req.method === 'GET' ? url.searchParams.get('sessionId') : body.sessionId
        if (!sessionId || sessionId.length > 256) throw new Error('Invalid session identity')
        if (!['GET', 'POST'].includes(req.method)) throw Error('Unsupported method')
        if (req.method === 'POST') await ctx.heronAiSessionChoices.select(sessionId, body)
        return reply(200, await ctx.heronAiSessionChoices.state(sessionId))
      }
      reply(404, { error: 'Unknown ACP endpoint' })
    } catch (error) {
      reply(400, { error: String(error.message).replace(/Bearer\s+\S+|\b(?:sk|ck|ds)-[A-Za-z0-9_-]+/gi, '[redacted]').slice(0, 500) })
    }
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/heron-ai-acp', handler }))
}
