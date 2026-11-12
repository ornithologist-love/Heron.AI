import path from 'node:path'
import { createTodoStore } from './store.mjs'
import { createTodoCapability } from './capability.mjs'
import { handleRequest, ROUTE } from './route.mjs'

export const name = 'todo-list'
export const inject = ['webServer', 'connection', 'capabilities', 'agents', 'sessionController', 'tools']
// One instance owns one document; the path is relative to the instance state
// directory so two state directories never share to-dos.
const DIRECTORY = path.join('dsh', 'todo-list')
const fail = (message, status = 400) => Object.assign(Error(message), { status })

export function apply(ctx, config = {}) {
  if (!config.stateDir) throw Error('todo-list needs the instance state directory')
  const store = createTodoStore(path.join(config.stateDir, DIRECTORY))
  const capability = createTodoCapability(ctx, store)
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    // A remote peer or an unauthenticated caller is not the owner of these to-dos.
    const admission = ctx.connection.admit(req)
    if ('rejection' in admission || admission.peer.principal.kind !== 'owner')
      return reply(403, { error: '仅本机用户可管理待办。' })
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname !== ROUTE && url.pathname !== ROUTE + '/tools')
      return reply(404, { error: '未找到待办接口。' })
    try {
      if (url.pathname === ROUTE + '/tools' && req.method === 'GET')
        return reply(200, await capability.state(url.searchParams.get('sessionId')))
      if (url.pathname === ROUTE + '/tools' && req.method === 'POST') {
        // Same custom header and JSON body as every other mutation, so a
        // cross-origin form cannot open the Agent's to-do tools.
        if (req.headers['x-todo-list'] !== 'tools' || !String(req.headers['content-type']).startsWith('application/json'))
          throw fail('待办工具启用请求格式无效。')
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (Buffer.byteLength(body) > 1024) throw fail('待办工具启用参数过大。', 413)
        }
        let input
        try { input = JSON.parse(body) } catch { throw fail('待办工具启用参数无效。') }
        return reply(200, await capability.state(input?.sessionId, true))
      }
      if (url.pathname === ROUTE) return handleRequest(ctx, store, req, res)
      res.setHeader('Allow', 'GET, POST')
      throw fail('待办接口不支持该方法。', 405)
    } catch (error) {
      // The panel shows this text verbatim: an enable failure must say so
      // instead of looking like a data problem.
      if (!error.status) ctx.logger.error('todo-list capability request failed: ' + (error.stack || error.message))
      reply(error.status || 500, { error: error.status ? error.message : '待办工具启用失败，请重新打开待办面板。' })
    }
  } }), 'todo-list: routes')
}
