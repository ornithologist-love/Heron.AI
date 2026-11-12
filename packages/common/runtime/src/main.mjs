// One DSH base with the in-tree HeronAI supplement.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initializeProductContent, contentLaunchOptions } from './heron-ai/product-profile.mjs'

try {
  process.env.HERON_AI_RUNTIME_ROOT = fileURLToPath(new URL('./', import.meta.url))
  const { prepareStateDirectory } = await import('./heron-ai/migration/branding.mjs')
  await prepareStateDirectory(contentLaunchOptions(process.argv.slice(2)))
  initializeProductContent(contentLaunchOptions(process.argv.slice(2)))
  const { launchDsh, launchOptions } = await import('./dsh/launch.mjs')
  const { prepareHeronAi } = await import('./heron-ai/bootstrap.mjs')
  const { prepareAspectOptions } = await import('./heron-ai/aspects.mjs')
  if (process.env.HERON_AI_EXIT_TRACE === '1') (await import('./heron-ai/exit-diagnostics.mjs')).startExitDiagnostics()
  const options = launchOptions(process.argv.slice(2))
  options.startupStartedAt = Date.now()
  const content = path.join(path.dirname(fileURLToPath(import.meta.url)), 'heron-ai', 'content')
  // Optional plugins contribute business content; the runtime defaults are neutral.
  if (!process.argv.includes('--skills-dir')) options.skillsDir = path.join(content, 'skills')
  if (!process.argv.includes('--templates-dir')) options.templatesDir = path.join(content, 'templates')
  options.mcpConfigFile ??= path.join(content, 'mcp-config.json')
  // Host-only launch facts (identity, model catalog, MCP product) come from the host package.
  if (options.hostPackage) (await import(options.hostPackage)).prepareOptions?.(options)
  await prepareAspectOptions(options)
  options.brandLogo ??= path.join(content, 'runtime-logo.svg')
  const include = await prepareHeronAi(options)
  process.stderr.write(`[heron-ai-dsh] preparation ${Date.now() - options.startupStartedAt}ms\n`)
  await launchDsh(options, include)
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
