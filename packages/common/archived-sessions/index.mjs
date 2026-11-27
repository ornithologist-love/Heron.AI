export const name = 'archived-sessions'
export const inject = ['connection', 'sessionController', 'webServer']

const endpoint = '/heron-ai-session-archive'
const loopbackAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const maxBodyBytes = 4096

function reply(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: endpoint,
    handler: async (req, res) => {
      const admission = ctx.connection.admit(req)
      if ('rejection' in admission) return reply(res, 403, { error: 'Request not authorized' })
      const canDelete = admission.peer === ctx.connection.browserPeer
        && admission.peer.principal.kind === 'owner'
        && req.headers.authorization === undefined
        && req.headers['x-dsh-model-remote'] === undefined
        && loopbackAddresses.has(req.socket?.remoteAddress)
        && typeof ctx.sessionController.deleteArchivedSession === 'function'
      if (req.method === 'GET') return reply(res, 200, { canDelete })
      if (req.method !== 'POST') return reply(res, 405, { error: 'Unsupported method' })
      if (!canDelete || req.headers['x-heron-archive-action'] !== 'delete') {
        return reply(res, 403, { error: 'Request not authorized' })
      }
      if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return reply(res, 415, { error: 'Expected application/json' })
      }

      let sessionId
      try {
        let size = 0
        const chunks = []
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          size += chunk.length
          if (size > maxBodyBytes) {
            req.resume()
            return reply(res, 413, { error: 'Request body too large' })
          }
          chunks.push(chunk)
        }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (typeof input?.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 512) {
          return reply(res, 400, { error: 'Invalid session ID' })
        }
        sessionId = input.sessionId
      } catch {
        return reply(res, 400, { error: 'Invalid request body' })
      }

      try {
        await ctx.sessionController.deleteArchivedSession(sessionId)
        return reply(res, 200, { ok: true })
      } catch (error) {
        ctx.logger.warn('Archived session deletion failed: %s', error?.code ?? error?.name ?? 'unknown')
        return reply(res, 409, { error: 'Could not delete the archived session' })
      }
    },
  }))
}
