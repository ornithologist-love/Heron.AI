import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { TemplateCatalog } from './runtime/template-store.mjs'
import { backendId } from './acp/providers.mjs'

export const inject = ['webServer', 'connection', 'sessionController']
export async function apply(ctx, config) {
  const store = new TemplateCatalog(config.templatesDir)
  const records = new Map(), writes = new Map(), sends = new Map()
  const filename = id => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,256}$/.test(id)) throw Error('Invalid template session identity')
    return path.join(config.home, 'templates', id + '.json')
  }
  async function read(id) {
    if (records.has(id)) return records.get(id)
    let value = null
    try { value = JSON.parse(await fs.readFile(filename(id), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    records.set(id, value); return value
  }
  async function save(id, value) {
    const text = JSON.stringify(value, null, 2)
    const operation = (writes.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const file = filename(id); await fs.mkdir(path.dirname(file), { recursive: true })
      const temporary = file + '.' + randomUUID() + '.tmp'
      await fs.writeFile(temporary, text); await fs.rename(temporary, file)
    })
    writes.set(id, operation); await operation; records.set(id, value)
  }
  const service = {
    registerSource: source => store.registerSource(source),
    async stateOf(id) {
      const row = await read(id)
      const configuration = await ctx.sessionController.configuration(id)
      const active = row && !row.consumed && configuration.blank
      return { selected: active ? row.template : null, values: active ? row.values : {},
        modelLocked: false }
    },
    async prompt(request, next) {
      const operation = (sends.get(request.sessionId) ?? Promise.resolve()).catch(() => {}).then(async () => {
        await writes.get(request.sessionId)
        const row = await read(request.sessionId)
        const configuration = await ctx.sessionController.configuration(request.sessionId)
        if (!row || row.consumed || !configuration.blank) return next(request)
        for (const field of row.template.fields) if (field.required && !String(row.values[field.name] ?? '').trim()) throw Error('请填写模板必填项：' + field.label)
        const prompt = row.template.prompt.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_, name) => String(row.values[name] ?? '').trim())
        const content = request.content.filter(item => item.type !== 'text' || item.text !== row.template.name)
        const result = await next({ ...request, content: [{ type: 'text', text: prompt + (content.length ? '\n\n' : '') }, ...content] })
        if (result.accepted) await save(request.sessionId, { ...row, consumed: request.requestId })
        return result
      })
      sends.set(request.sessionId, operation); return operation
    },
  }
  ctx.provide('heronAiTemplates', service)
  const handler = async (req, res) => {
    const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)) }
    if (ctx.connection.requestRejection(req)) return reply(403, { error: 'Request not authorized' })
    const url = new URL(req.url, 'http://127.0.0.1')
    try {
      let body = {}
      if (req.method !== 'GET') {
        let text = ''; for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 1024 * 1024) throw Error('Template fields are too large') }
        body = JSON.parse(text || '{}')
      }
      if (url.pathname === '/heron-ai-templates/catalog' && req.method === 'GET') return reply(200, await store.read())
      if (url.pathname === '/heron-ai-templates/open' && req.method === 'POST') {
        const directory = await store.directoryFor(body.templateId)
        await fs.stat(directory)
        spawn('explorer.exe', [directory], { windowsHide: true, detached: true, stdio: 'ignore' }).unref()
        return reply(200, { opened: true })
      }
      if (url.pathname === '/heron-ai-templates/session') {
        const id = req.method === 'GET' ? url.searchParams.get('sessionId') : body.sessionId
        filename(id)
        const configuration = await ctx.sessionController.configuration(id)
        const provider = backendId(configuration.agentPreset)
        if (req.method === 'POST') {
          if (!configuration.blank) throw Error('功能模板只作用于新会话首次发送')
          if (body.templateId === null) await save(id, null)
          else {
            const template = (await store.read()).templates.find(item => item.id === body.templateId)
            if (!template) throw Error('模板已删除，请刷新模板后重新选择')
            const values = Object.fromEntries(template.fields.map(field => [field.name, String(field.default_value ?? '')]))
            await save(id, { template: structuredClone(template), values, provider: provider ?? 'dsh', consumed: null })
          }
        } else if (req.method === 'PUT') {
          const row = await read(id)
          if (!row || row.consumed || !configuration.blank) throw Error('当前会话没有待填写的功能模板')
          const values = {}
          for (const field of row.template.fields) {
            const value = body.values?.[field.name] ?? ''
            if (typeof value !== 'string' || value.length > 256 * 1024) throw Error('模板输入项无效：' + field.label)
            values[field.name] = value
          }
          await save(id, { ...row, values })
        } else if (req.method !== 'GET') throw Error('Unsupported method')
        return reply(200, await service.stateOf(id))
      }
      reply(404, { error: 'Unknown template endpoint' })
    } catch (error) { reply(400, { error: String(error.message).replace(/Bearer\s+\S+|\b(?:sk|ck|ds)-[A-Za-z0-9_-]+/gi, '[redacted]').slice(0, 500) }) }
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/heron-ai-templates', handler }))
}
