import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { createGoogleAuth } from './auth.mjs'
import { isLocalBrowserOwner, localGoogleTurns } from './local-access.mjs'
import { googleWorkspaceTools } from './tools.mjs'
import { googleServices } from './services.mjs'
import { registerGoogleSkills } from './skills.mjs'

export const name = 'google-connector'
export const inject = [
  'approval', 'authorization', 'connection', 'credentials', 'mcpManagerIntegration', 'skills', 'tools', 'webServer',
]

const endpoint = '/heron-ai-google-connector'
const maxBody = 8192

class InvalidDesktopClient extends Error {}

function desktopClient(value) {
  const client = value?.installed
  if (!client || typeof client.client_id !== 'string'
    || (client.client_secret !== undefined && typeof client.client_secret !== 'string')) {
    throw new InvalidDesktopClient('Expected a Google Desktop OAuth client JSON file.')
  }
  return { clientId: client.client_id, clientSecret: client.client_secret }
}

function reply(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > maxBody) {
      request.resume()
      throw new Error('Request body too large')
    }
    chunks.push(chunk)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request')
  return value
}

export async function apply(ctx) {
  const runtime = JSON.parse(process.env.HERON_AI_DSH_LAUNCH ?? '{}')
  const require = createRequire(runtime.hostRoot ? path.join(runtime.hostRoot, 'package.json') : import.meta.url)
  const { withFileLock, writeFileAtomic } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')).href)
  const servicesFile = path.join(runtime.stateDir, 'google-connector-services.json')
  const readPreferences = async () => {
    try { return JSON.parse(await readFile(servicesFile, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error }
  }
  const preferences = await readPreferences()
  const enabled = new Set(googleServices.filter(service =>
    (preferences[service.id] ?? service.defaultEnabled) === true).map(service => service.id))
  const isEnabled = id => enabled.has(id)
  const clientFile = process.env.HERON_GOOGLE_CONNECTOR_CLIENT_FILE
  let managedClient
  if (clientFile) {
    try {
      if (!path.isAbsolute(clientFile)) throw new Error()
      managedClient = desktopClient(JSON.parse(await readFile(clientFile, 'utf8')))
    } catch {
      throw new Error('HERON_GOOGLE_CONNECTOR_CLIENT_FILE must point to a Google Desktop OAuth client JSON file.')
    }
  }
  const openAuthorizationUrl = url => ctx.mcpManagerIntegration.openAuthorizationUrl(url, { systemOnly: true })
  const auth = createGoogleAuth({
    credentials: ctx.credentials,
    authorization: ctx.authorization,
    openAuthorizationUrl,
    requestedScopes: () => googleServices.filter(service => isEnabled(service.id)).flatMap(service => service.scopes),
  })
  ctx.effect(() => () => auth.dispose())
  if (managedClient) await auth.configure(managedClient)
  const local = localGoogleTurns(ctx)
  const definitions = googleWorkspaceTools({
    accessToken: options => auth.getAccessToken(options),
  })
  const catalog = definitions.map(({ toolset, name, description }) => ({ toolset, name, description }))
  const registrations = new Map()
  const invalidateSkills = registerGoogleSkills(ctx, { isEnabled })

  async function registerTools(id) {
    const toolset = `google.${id}`
    const disposers = []
    const dispose = () => { for (const unregister of disposers) unregister() }
    const check = agent => isEnabled(id) && local(agent)
    try {
      for (const { toolset: _group, mutates, execute, ...schema } of definitions.filter(tool => tool.toolset === toolset)) {
        const definition = {
          ...schema,
          async execute(args, exec) {
            if (!check(exec.agent)) throw new Error('Enable the Google service and use it from the local Heron.AI window.')
            const preview = schema.name === 'google_docs_replace_text' && args.dry_run === true
            if (mutates && !preview) {
              const decision = await ctx.approval.request({
                agent: exec.agent, toolName: schema.name, callId: exec.callId,
                reason: 'Apply the requested edits to the Google Docs document.',
                displayReason: { en: 'Apply these edits to Google Docs?', zh: '应用这些 Google 文档编辑？' },
                signal: exec.signal,
              })
              if (decision !== 'allowed-once') throw new Error('Google Docs edit was not approved.')
            }
            exec.signal.throwIfAborted()
            if (!check(exec.agent)) throw new Error('Google service is no longer available for this turn.')
            return execute(args, exec)
          },
        }
        const options = await ctx.waterfall('mcp/tool-registration', toolset, definition, () => ({
          when: ({ agent }) => check(agent),
        }))
        disposers.push(ctx.tools.register(definition, options))
      }
      return dispose
    } catch (error) {
      dispose()
      throw error
    }
  }

  ctx.effect(() => () => { for (const unregister of registrations.values()) unregister() })
  for (const id of enabled) registrations.set(id, await registerTools(id))

  const updateService = (id, active) => withFileLock(servicesFile, async () => {
    if (active === isEnabled(id)) return
    const disposeNew = active ? await registerTools(id) : undefined
    try {
      const saved = await readPreferences()
      await writeFileAtomic(servicesFile, JSON.stringify({ ...saved, [id]: active }), { mode: 0o600 })
    } catch (error) {
      disposeNew?.()
      throw error
    }
    if (active) {
      enabled.add(id)
      registrations.set(id, disposeNew)
    } else {
      enabled.delete(id)
      registrations.get(id)?.()
      registrations.delete(id)
    }
    invalidateSkills()
  })

  const status = async () => {
    const account = await auth.status()
    return {
      ...account,
      services: googleServices.map(({ id, label, scopes }) => ({
        id, label, toolset: `google.${id}`, enabled: isEnabled(id),
        authorized: scopes.every(scope => account.grantedScopes?.includes(scope)),
      })),
      tools: catalog,
    }
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: endpoint,
    async handler(request, response) {
      if (!isLocalBrowserOwner(ctx.connection, request)) return reply(response, 403, { error: 'Local account required.' })
      if (request.method === 'GET') return reply(response, 200, await status())
      if (request.method !== 'POST') return reply(response, 405, { error: 'Unsupported method.' })
      if (request.headers['x-heron-google-connector'] !== '1'
        || request.headers['content-type']?.split(';')[0] !== 'application/json') {
        return reply(response, 403, { error: 'Request not authorized.' })
      }
      try {
        const body = await readBody(request)
        if (body.action === 'import-client' && !managedClient) {
          await auth.configure(desktopClient(body.client))
          await auth.connect()
        } else if (body.action === 'open-setup' && !managedClient) {
          try { await openAuthorizationUrl(new URL('https://console.cloud.google.com/auth/clients')) }
          catch { return reply(response, 502, { code: 'browserFailed' }) }
        } else if (body.action === 'connect') await auth.connect()
        else if (body.action === 'copy-link') await auth.connect({ method: 'manual' })
        else if (body.action === 'cancel') await auth.cancel()
        else if (body.action === 'disconnect') await auth.disconnect()
        else if (body.action === 'set-service') {
          if (typeof body.enabled !== 'boolean' || !googleServices.some(service => service.id === body.service)) {
            return reply(response, 400, { error: 'Invalid Google service setting.' })
          }
          await updateService(body.service, body.enabled)
        } else return reply(response, 400, { error: 'Unknown action.' })
        return reply(response, 200, await status())
      } catch (failure) {
        if (failure instanceof InvalidDesktopClient) return reply(response, 400, { code: 'invalidClient' })
        return reply(response, 500, { error: 'Google Connector could not complete the request.' })
      }
    },
  }))
}
