import crypto from 'node:crypto';

export function installCapabilityEndpoint(ctx, controller, descriptor) {
  const requestToken = crypto.randomBytes(24).toString('hex');
  ctx.on('webserver/index-inject', table => {
    table.push({kind: 'global', name: descriptor.requestTokenName, value: requestToken});
    table.push({kind: 'global', name: descriptor.clientDescriptorName, value: descriptor});
  });
  ctx.effect(() => ctx.webServer.register({kind: 'exact', path: descriptor.endpoint, handler: async (req, res) => {
    const reply = (status, value) => {
      res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(value));
    };
    if (req.headers[descriptor.requestHeader.toLowerCase()] !== requestToken) { reply(403, {message: 'Request not authorized.'}); return; }
    try {
      let sessionId, enabled;
      if (req.method === 'GET') sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId');
      else if (req.method === 'POST') {
        let body = '';
        for await (const chunk of req) {
          body += chunk; if (body.length > 4096) {reply(413, {message: 'Request too large.'}); return;}
        }
        ({sessionId, enabled} = JSON.parse(body));
        if (typeof enabled !== 'boolean') {reply(400, {message: 'Invalid toggle.'}); return;}
      } else {reply(405, {message: 'Unsupported method.'}); return;}
      if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(sessionId)) {reply(400, {message: 'Invalid session.'}); return;}
      const handle = await ctx.sessionController.observe(sessionId);
      try {
        if (handle.header.origin === 'subagent') {reply(400, {message: `请回到主对话设置 ${descriptor.label}。`}); return;}
      } finally {handle[Symbol.dispose]();}
      reply(200, req.method === 'POST' ? await controller.set(sessionId, enabled) : controller.get(sessionId));
    } catch {reply(400, {message: `无法设置 ${descriptor.label}，请确认当前对话仍存在。`});}
  }}));
}
