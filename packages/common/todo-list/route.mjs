// Owner-only local route for personal to-dos. GET reads the list; every change
// is a POST carrying the panel's custom header and a JSON body, so a
// cross-origin form or a non-owner peer cannot mutate the store.
export const ROUTE = '/todo-list'
const METHOD_HEADER = 'x-todo-list'
/** Comfortably above one maximal item plus its JSON envelope. */
const MAX_BODY_BYTES = 16384

const fail = (message, status = 400) => Object.assign(Error(message), { status })

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  // Content-Length is advisory: the streamed limit is what actually bounds the read.
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw fail('待办请求参数过大。', 413)
  }
  try {
    const input = JSON.parse(body)
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw Error()
    return input
  } catch {
    throw fail('待办请求参数无效。')
  }
}

/**
 * Dispatch one request.
 * @param ctx - plugin context; only `connection` is read here.
 * @param store - to-do store of this instance.
 * @param req - incoming HTTP request.
 * @param res - response owned by this handler.
 */
export async function handleRequest(ctx, store, req, res) {
  // A remote peer or an unauthenticated caller is not the owner of these to-dos.
  const admission = ctx.connection.admit(req)
  if ('rejection' in admission || admission.peer.principal.kind !== 'owner')
    return reply(res, 403, { error: '仅本机用户可管理待办。' })
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname !== ROUTE) return reply(res, 404, { error: '未找到待办接口。' })
  // Refuse a mutation that a browser could have produced without our header.
  if (req.method === 'POST' && (req.headers[METHOD_HEADER] !== 'mutate'
    || !String(req.headers['content-type']).startsWith('application/json')))
    throw fail('待办请求格式无效。')
  try {
    if (req.method === 'GET') return reply(res, 200, await store.list())
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST')
      throw fail('待办接口不支持该方法。', 405)
    }
    const input = await readBody(req)
    if (input.action === 'create') return reply(res, 200, await store.create(input.title, input.description))
    if (input.action === 'update')
      return reply(res, 200, await store.update(input.id, input.title, input.description))
    if (input.action === 'set-done') return reply(res, 200, await store.setDone(input.id, input.done))
    if (input.action === 'delete') return reply(res, 200, await store.remove(input.id))
    throw fail('未知的待办操作。')
  } catch (error) {
    if (!error.status) ctx.logger.error('todo-list request failed: ' + (error.stack || error.message))
    // Store-level damage is user-visible content, not a swallowed internal failure.
    reply(res, error.status || 500, { error: error.status ? error.message
      : error.name === 'TodoDataError' ? error.message
        : '待办操作失败，请稍后重试。' })
  }
}
