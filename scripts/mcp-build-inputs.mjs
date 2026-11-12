import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

// Resolve only inputs required by explicitly selected content packages, before
// assembly changes the output. Never log credential values or copy this file.
export function readMcpBuildInputs(directories, compositionSecretsFile) {
  const variables = new Set()
  for (const directory of directories) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
    const content = manifest.heronAi?.content?.['mcp-config.json']
    if (!content) continue
    const config = JSON.parse(fs.readFileSync(path.join(directory, content), 'utf8'))
    for (const server of Object.values(config.mcpServers ?? {}))
      if (server.bearerTokenEnv) variables.add(server.bearerTokenEnv)
  }
  const filename = process.env.HERON_AI_MCP_SECRETS_FILE ?? compositionSecretsFile
    ?? path.join(homedir(), '.heron-ai', 'build-secrets', 'mcp.json')
  const tokens = new Map(), files = []
  let secrets
  for (const variable of variables) {
    if (typeof variable !== 'string') throw Error('Invalid MCP build credential reference')
    let token = process.env[variable]
    if (!token) {
      if (secrets === undefined) {
        try { secrets = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')) }
        catch { throw Error('Missing or invalid private MCP build input; set HERON_AI_MCP_SECRETS_FILE or the referenced token environment variable') }
        files.push(path.resolve(filename))
      }
      token = secrets?.[variable]
    }
    if (typeof token !== 'string' || !token || Buffer.byteLength(token) > 512 || /[\s\x00-\x1f\x7f]/u.test(token))
      throw Error('Missing or invalid MCP build credential: ' + variable)
    tokens.set(variable, token)
  }
  return { tokens, files }
}
