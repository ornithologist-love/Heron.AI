import { defineTool } from '@deepseek-ai/dsh-tools'
import { MAX_DESCRIPTION_LENGTH, MAX_TITLE_LENGTH } from './store.mjs'

// One name, so the owner guard and the deletion gate below cover exactly the
// tools this module registers.
const ID = 'todo-list'
const string = { type: 'string', required: true }
const object = properties => ({ type: 'object', additionalProperties: false, properties })
const output = schema => ({ schema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] })
const todoSchema = object({
  id: string, title: string, description: string,
  done: { type: 'boolean', required: true },
  created_at: { type: 'number', required: true, description: 'Unix milliseconds.' },
  updated_at: { type: 'number', required: true, description: 'Unix milliseconds.' },
})
// Every mutation returns the complete document, so the model never needs a
// follow-up read to learn what the panel now shows.
const documentSchema = object({ total: { type: 'number', required: true }, pending: { type: 'number', required: true },
  done: { type: 'number', required: true }, todos: { type: 'array', required: true, items: todoSchema } })
const idParameter = { type: 'string', required: true,
  description: 'Todo id returned by todo-list_list; never a title or an index.' }
const TITLE_RULE = 'Include it when replacing the title; an omitted field keeps its stored value.'

// Whole-name matching keeps these tools from colliding with an unrelated
// prefix such as a plugin named todo-list-extras.
const owned = name => name === ID || name.startsWith(ID + '_')

// The HTTP route and the panel only serve the local owner, and the same
// boundary must hold when an Agent calls the tools. The RPC layer records
// non-owner principals on user messages inside the current turn; without a
// local user message in this turn (for example an automation round) the tools
// stay closed.
function ownerIssue(exec) {
  const session = exec.agent?.session
  if (!session) return '待办工具仅允许本机用户的聊天 Agent 调用。'
  let owner = false
  for (let seq = session.seq - 1; seq >= 0; seq--) {
    const event = session.eventAt(seq)
    if (event?.type === 'turn/start') break
    if (event?.type !== 'user/message' || event.data.source?.kind !== 'user') continue
    const principal = event.data.source.principal
    if (principal && principal.kind !== 'owner') return '共享访问者不能通过聊天工具读取或修改本机待办。'
    owner = true
  }
  return owner ? undefined : '当前轮次没有本机用户发起的消息，不能访问本机待办。'
}

function todoView(todo) {
  return { id: todo.id, title: todo.title, description: todo.description, done: todo.done,
    created_at: todo.createdAt, updated_at: todo.updatedAt }
}

function documentView({ todos, pending }) {
  return { total: todos.length, pending, done: todos.length - pending, todos: todos.map(todoView) }
}

/** Human description of one item, used in the native approval of a deletion. */
const card = todo => '「' + (todo.title.length > 60 ? todo.title.slice(0, 60) + '…' : todo.title) + '」'

/**
 * Mount the to-do tools in one Agent's context.
 * @param ctx - Agent-scoped context with `tools`.
 * @param store - the instance to-do store shared with the panel route.
 */
export function registerTodoTools(ctx, store) {
  ctx.tools.guard(exec => owned(exec.name) ? ownerIssue(exec) : undefined)
  // Deleting is irreversible, so it goes through DSH native approval like the
  // archive's single-session delete. The approval decision is DSH's alone: no
  // model argument can skip it, and a session whose approval prompts are
  // disabled (完全访问 sets the policy to never) is allowed by that policy
  // itself instead of showing the model a refusal the user never made.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== ID + '_delete') return next()
    const issue = ownerIssue(exec)
    if (issue) return { kind: 'deny', reason: issue }
    const decision = await next()
    if (decision.kind !== 'allow' && decision.kind !== 'ask') return decision
    const id = exec.arguments?.id
    // Re-check under the store's own lock: the item may be gone since list.
    let current
    try {
      const state = await store.list({ signal: exec.signal })
      current = typeof id === 'string' ? state.todos.find(todo => todo.id === id) : undefined
      if (!current) return { kind: 'deny', reason: '未找到该待办，请先用 todo-list_list 刷新列表。' }
    } catch (error) {
      return { kind: 'deny', reason: error.message }
    }
    const approval = ctx.get('approval'), session = exec.agent?.session
    if (approval && session && (approval.overrideOf(session) ?? approval.config.policy) === 'never') return decision
    const reason = '永久删除待办' + card(current) + '。删除后无法恢复。'
    return { kind: 'ask', reason, displayReason: { en: reason, zh: reason } }
  })

  // The capability controller mounts these in the selected chat's context only
  // while the 待办 panel is open; DSH owns the tool-addition history itself.
  ctx.tools.register(defineTool({
    name: ID + '_list',
    description: 'Read every personal to-do of this HeronAI instance — the same list the 待办 panel shows — including titles, full descriptions, done flags and Unix-millisecond timestamps. The result carries the complete list with total/pending/done counts; there is no paging. Read-only.',
    parameters: {},
    output: output(documentSchema),
    isConcurrencySafe: () => true,
    async execute(_args, exec) { return documentView(await store.list({ signal: exec.signal })) },
  }))
  ctx.tools.register(defineTool({
    name: ID + '_create',
    description: 'Append one item to the 待办 panel. title is one trimmed line of at most ' + MAX_TITLE_LENGTH + ' characters and is required; description may span lines, up to ' + MAX_DESCRIPTION_LENGTH + ' characters, and may be empty. Returns the complete list after the change.',
    parameters: { title: { ...string, description: 'One line; newlines are refused.' },
      description: { type: 'string', description: 'Optional body of the item.' } },
    output: output(documentSchema),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return documentView(await store.create(args.title, args.description, { signal: exec.signal }))
    },
  }))
  ctx.tools.register(defineTool({
    name: ID + '_update',
    description: 'Edit the title and/or description of one existing item. Give at least one of them; an omitted field keeps its stored value, so {"description": "…"} rewrites only the body. Pass a description of "" to clear it. Returns the complete list after the change.',
    parameters: { id: idParameter, title: { type: 'string', description: 'New title. ' + TITLE_RULE },
      description: { type: 'string', description: 'New body; omit to keep the stored description.' } },
    output: output(documentSchema),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (args.title === undefined && args.description === undefined)
        throw Error('请至少提供 title 或 description 中的一项；省略的字段保持原值。')
      // The store takes a complete title; the current one is the default for a
      // description-only edit, which keeps the read-modify-write inside its lock.
      const current = args.title === undefined
        ? (await store.list({ signal: exec.signal })).todos.find(todo => todo.id === args.id)
        : undefined
      if (args.title === undefined && !current) throw Error('未找到该待办，请先用 todo-list_list 刷新列表。')
      const title = args.title ?? current.title
      return documentView(await store.update(args.id, title, args.description, { signal: exec.signal }))
    },
  }))
  ctx.tools.register(defineTool({
    name: ID + '_set_done',
    description: 'Tick or untick one item in the 待办 panel. done=true marks it complete, done=false reopens it. Repeating the current state is a no-op. Returns the complete list after the change.',
    parameters: { id: idParameter, done: { type: 'boolean', required: true } },
    output: output(documentSchema),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return documentView(await store.setDone(args.id, args.done, { signal: exec.signal }))
    },
  }))
  ctx.tools.register(defineTool({
    name: ID + '_delete',
    description: 'Permanently delete one item from the 待办 panel. Asks the user for approval unless approval prompts are disabled in this session; no argument can skip that approval. Name the exact item to the user before calling. Returns the complete remaining list.',
    parameters: { id: idParameter },
    output: output(documentSchema),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return documentView(await store.remove(args.id, { signal: exec.signal }))
    },
  }))
}
