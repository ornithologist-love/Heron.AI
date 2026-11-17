// Keep loaded tools conversation-local. Names survive a connection generation
// swap; weak session keys release the selection with the conversation.
export function registerMcpToolDiscovery(ctx) {
  const selected = new WeakMap()
  const servers = new WeakMap()
  const alwaysLoaded = server => /^unreal(?:[-_]?mcp)?$/i.test(server)
  const selection = session => {
    let names = selected.get(session)
    if (!names) { names = new Set(); selected.set(session, names) }
    return names
  }

  ctx.on('mcp/tool-registration', async (server, tool, next) => {
    const options = await next()
    servers.set(tool, server)
    if (alwaysLoaded(server)) return options
    return {
      ...options,
      when: async context => selection(context.agent.session).has(tool.name)
        && (!options.when || await options.when(context)),
    }
  })

  ctx.tools.register({
    name: 'search_mcp_tools',
    description: 'Find external MCP tools by server name, tool name, or keywords. Matching tools become available in this conversation on the next step. Search before using external services. An empty query lists available servers without loading tools. Unreal editor tools are always available.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Tool/server name or keywords; empty to list servers.' },
        server: { type: 'string', description: 'Optional exact server name to narrow the search.' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Maximum tools to load; default 5.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (!exec.agent) throw Error('MCP tool discovery requires a conversation')
      const tools = ctx.tools.definitions(exec.agent)
        .filter(tool => servers.has(tool))
      const inventory = new Map()
      for (const tool of tools) {
        const server = servers.get(tool)
        inventory.set(server, (inventory.get(server) ?? 0) + 1)
      }
      const available = [...inventory].sort(([a], [b]) => a.localeCompare(b))
        .map(([server, toolCount]) => ({ server, toolCount, alwaysLoaded: alwaysLoaded(server) }))
      const query = String(args?.query ?? '').trim().toLowerCase()
      const server = args?.server
      if (!query && !server) return { servers: available, tools: [] }
      const terms = query.split(/[\s,，]+/u).filter(Boolean)
      const matches = tools.filter(tool => !server || servers.get(tool) === server).map(tool => {
        const name = `${servers.get(tool)} ${tool.name}`.toLowerCase()
        const description = tool.description.toLowerCase()
        const score = terms.reduce((sum, term) => sum + (name.includes(term) ? 3 : description.includes(term) ? 1 : 0), 0)
        return { tool, score }
      }).filter(match => !terms.length || match.score > 0)
        .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
      const limit = Number.isInteger(args?.limit) ? Math.min(10, Math.max(1, args.limit)) : 5
      const loaded = selection(exec.agent.session)
      const results = matches.slice(0, limit).map(({ tool }) => {
        loaded.add(tool.name)
        return { server: servers.get(tool), name: tool.name, description: tool.description }
      })
      return { tools: results, totalMatches: matches.length, ...(results.length ? {} : { servers: available }) }
    },
  })
}
