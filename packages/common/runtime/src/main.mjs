// One DSH base with the in-tree HeronAI supplement.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

async function main(args) {
  const hostRoot = fileURLToPath(new URL('./', import.meta.url))
  if (args[0] === 'agent-plugin') {
    const { runAgentPluginCommand } = await import('./heron-ai/agent-plugins/export-command.mjs')
    await runAgentPluginCommand(args.slice(1), hostRoot)
    return
  }
  process.env.HERON_AI_RUNTIME_ROOT = hostRoot
  const { initializeProductContent, contentLaunchOptions } = await import('./heron-ai/product-profile.mjs')
  const contentOptions = contentLaunchOptions(args)
  const { prepareStateDirectory } = await import('./heron-ai/migration/branding.mjs')
  await prepareStateDirectory(contentOptions)
  initializeProductContent(contentOptions)
  const { launchDsh, launchOptions } = await import('./dsh/launch.mjs')
  const { prepareHeronAi } = await import('./heron-ai/bootstrap.mjs')
  const { prepareAspectOptions } = await import('./heron-ai/aspects.mjs')
  if (process.env.HERON_AI_EXIT_TRACE === '1') (await import('./heron-ai/exit-diagnostics.mjs')).startExitDiagnostics()
  const options = launchOptions(args)
  options.startupStartedAt = Date.now()
  const content = path.join(hostRoot, 'heron-ai', 'content')
  // Optional plugins contribute business content; the runtime defaults are neutral.
  if (!process.argv.includes('--skills-dir')) options.skillsDir = path.join(content, 'skills')
  if (!process.argv.includes('--templates-dir')) options.templatesDir = path.join(content, 'templates')
  options.mcpConfigFile ??= path.join(content, 'mcp-config.json')
  // Host-only launch facts (identity, model catalog, MCP product) come from the host package.
  if (options.hostPackage) (await import(options.hostPackage)).prepareOptions?.(options)
  await prepareAspectOptions(options)
  options.brandLogo ??= path.join(content, 'runtime-logo.png')
  const include = await prepareHeronAi(options)
  process.stderr.write(`[heron-ai-dsh] preparation ${Date.now() - options.startupStartedAt}ms\n`)
  await launchDsh(options, include)
}

try {
  await main(process.argv.slice(2))
} catch (error) {
  let current = error
  const messages = []
  const seen = new Set()
  while (current && !seen.has(current) && messages.length < 8) {
    seen.add(current)
    messages.push(String(current.message ?? current).replace(/Bearer\s+\S+|\b(?:sk|ck|ds)-[A-Za-z0-9_-]+/gi, '[redacted]'))
    current = current.cause
  }
  process.stderr.write('[heron-ai-dsh] ' + messages.join(': ') + '\n')
  process.exitCode = 1
}
