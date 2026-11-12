// One HeronAI supplement. DSH owns the application; these are its internal services.
import * as Providers from './acp/providers.mjs'
import * as AgentDriver from './acp/agent-driver.mjs'
import * as Templates from './templates.mjs'
import * as ProviderApi from './provider-api.mjs'
import * as Host from './host.mjs'
import * as McpIntegration from './mcp-manager.mjs'
import * as SessionPolicy from './acp/session-controller.mjs'
import * as SessionChoices from './acp/session-choices.mjs'
import * as Workspaces from './workspaces/index.mjs'
import { observeExitLifecycle } from './exit-diagnostics.mjs'

export const name = 'heron-ai'
export function apply(ctx, config) {
  observeExitLifecycle(ctx)
  ctx.plugin(Providers, config)
  ctx.plugin(SessionChoices, config)
  ctx.plugin(Templates, config)
  ctx.plugin(AgentDriver)
  ctx.plugin(SessionPolicy)
  ctx.plugin(ProviderApi)
  // Automation's ACP transport owns stdin; the desktop Host resumes it for EOF
  // watching and would consume requests before the ACP plugin has mounted.
  if (!config.automation) ctx.plugin(Host, config)
  ctx.plugin(McpIntegration)
  ctx.plugin(Workspaces, config)
}
