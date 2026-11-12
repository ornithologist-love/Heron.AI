import { SessionCapabilityController } from '@common/capabilities/controller'
import { registerTodoTools } from './tools.mjs'

const descriptor = { id: 'todo-list', schemaVersion: 1, label: '待办' }
const fail = (message, status = 400) => Object.assign(Error(message), { status })

/**
 * Create the per-chat capability that mounts the to-do tools.
 * @param ctx - plugin context with `agents`, `capabilities` and `sessionController`.
 * @param store - the instance to-do store shared with the panel route.
 * @returns `state(sessionId, activate)`, used by the `/todo-list/tools` route.
 */
export function createTodoCapability(ctx, store) {
  // Opening the 待办 panel opts this chat in for this process only. A fresh
  // process starts with no tools mounted; nothing is persisted and no other
  // chat is affected, so switching chats never leaves tools on the wrong Agent.
  let choices = { sessions: {} }
  const controller = new SessionCapabilityController({
    settings: { get: () => choices, replace: next => { choices = next } },
    findAgent: id => ctx.agents.get(id),
    defaultEnabled: false,
    errorMessage: '待办工具启用失败，请重新打开待办面板。',
    openConnection: async () => ({
      mount(agentCtx) {
        const fiber = agentCtx.plugin({ name: 'todo-list-tools', inject: ['tools'],
          apply: toolCtx => registerTodoTools(toolCtx, store) })
        return () => fiber.dispose()
      },
      async close() {},
    }),
  })
  ctx.effect(() => ctx.capabilities.register(descriptor, controller), 'todo-list: capability')
  return {
    async state(sessionId, activate = false) {
      if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(sessionId))
        throw fail('请选择一个本机聊天。')
      const observation = await ctx.sessionController.observe(sessionId)
      try {
        if (observation.header.origin === 'subagent') throw fail('请在主聊天打开待办面板。')
      } finally { observation[Symbol.dispose]() }
      const state = controller.snapshot(sessionId)
      if (activate && (!state.desired || state.phase === 'error')) return controller.set(sessionId, true)
      return state
    },
  }
}
