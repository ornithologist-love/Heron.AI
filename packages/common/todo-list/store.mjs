// Personal to-do items of one HeronAI instance: a single JSON document under the
// instance state directory. Everything that reaches the stored document passes
// through here, so the HTTP layer never holds its own copy of the rules.
//
// Document generations:
//   v1  { version: 1, todos: [{ id, text, done, createdAt, updatedAt }] }
//   v2  { version: 2, todos: [{ id, title, description, done, createdAt, updatedAt }] }
// A v1 document still opens: its `text` becomes the card title and the
// description starts empty. The upgrade happens only in memory and only the
// user's next write persists v2, so merely looking at old data never rewrites it.
//
// Two callers share this store: the owner-only route of the panel and the Agent
// tools mounted while the panel is open. Both go through these methods, so
// neither keeps its own copy of the rules, and every method accepts an optional
// `signal` so a cancelled request or tool call stops before writing.
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** A card title is one trimmed line. */
export const MAX_TITLE_LENGTH = 200
/** A card description may span lines; empty is allowed. */
export const MAX_DESCRIPTION_LENGTH = 4000
/** Typical items are far smaller; the bound only stops pathological requests. */
export const MAX_TODOS = 500

const FILE_NAME = 'todos.json'
const VERSION = 2
const LEGACY_VERSION = 1

const fail = (message, status = 400) => Object.assign(Error(message), { status })

/** Message of a damaged document; never overwritten by a later write. */
export class TodoDataError extends Error {
  constructor(file, detail) {
    super('待办数据文件损坏：' + file + '（' + detail + '）。为避免覆盖，待办已停止读写，请修复或备份后移除该文件。')
    this.name = 'TodoDataError'
    this.file = file
  }
}

const isStoredTitle = value => typeof value === 'string' && value.trim() === value && value.length > 0
  && value.length <= MAX_TITLE_LENGTH && !/[\r\n]/.test(value)
const isStoredDescription = value => typeof value === 'string' && value.trim() === value
  && value.length <= MAX_DESCRIPTION_LENGTH
const isStoredIdentity = todo => todo !== null && typeof todo === 'object'
  && typeof todo.id === 'string' && todo.id.length > 0 && todo.id.length <= 64
  && typeof todo.done === 'boolean'
  && Number.isFinite(todo.createdAt) && Number.isFinite(todo.updatedAt)

const validV2Todo = todo => isStoredIdentity(todo) && isStoredTitle(todo.title) && isStoredDescription(todo.description)
const validV1Todo = todo => isStoredIdentity(todo) && isStoredTitle(todo.text)

/**
 * Validate a parsed document. A malformed document is reported, never repaired:
 * rewriting it would destroy the user's only copy of whatever went wrong.
 * @param file - document path used in the error message.
 * @param value - parsed JSON value.
 * @returns the validated to-do list, already in the v2 shape.
 * @throws {TodoDataError} when the document is not a complete, well-formed store.
 */
export function parseDocument(file, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TodoDataError(file, '不是待办文档')
  const legacy = value.version === LEGACY_VERSION
  if (!legacy && value.version !== VERSION) throw new TodoDataError(file, '版本未知')
  if (!Array.isArray(value.todos)) throw new TodoDataError(file, '缺少待办列表')
  if (value.todos.length > MAX_TODOS) throw new TodoDataError(file, '待办数量超限')
  if (!value.todos.every(legacy ? validV1Todo : validV2Todo)) throw new TodoDataError(file, '存在不合法的待办条目')
  const ids = new Set(value.todos.map(todo => todo.id))
  if (ids.size !== value.todos.length) throw new TodoDataError(file, '待办标识重复')
  if (!legacy) return value.todos
  // v1 items keep every stored field; only the name of the single text slot changes.
  return value.todos.map(todo => ({
    id: todo.id, title: todo.text, description: '', done: todo.done,
    createdAt: todo.createdAt, updatedAt: todo.updatedAt,
  }))
}

/** Normalize one user-supplied title, refusing empty and over-long input. */
export function requireTitle(value) {
  if (typeof value !== 'string') throw fail('待办标题必须是文字。')
  if (/[\r\n]/.test(value)) throw fail('待办标题只能是一行文字，多行内容请写进描述。')
  const title = value.trim()
  if (!title) throw fail('待办标题不能为空。')
  if (title.length > MAX_TITLE_LENGTH) throw fail('待办标题不能超过 ' + MAX_TITLE_LENGTH + ' 个字符。')
  return title
}

/** Normalize one user-supplied description; it may be empty or span lines. */
export function requireDescription(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw fail('待办描述必须是文字。')
  const description = value.trim()
  if (description.length > MAX_DESCRIPTION_LENGTH)
    throw fail('待办描述不能超过 ' + MAX_DESCRIPTION_LENGTH + ' 个字符。')
  return description
}

/**
 * Open the to-do document of one instance.
 * @param directory - `<stateDir>/dsh/todo-list`.
 * @returns the store bound to that directory.
 */
export function createTodoStore(directory) {
  const file = path.join(directory, FILE_NAME)
  // Reads never repair or rewrite the document, so a damaged file stays exactly
  // as the user left it and every later write fails with the same report.
  let damaged
  const markDamaged = error => {
    damaged = error instanceof TodoDataError ? error : new TodoDataError(file, error.message)
    return damaged
  }
  async function read(signal) {
    if (damaged) throw damaged
    signal?.throwIfAborted()
    let bytes
    try {
      bytes = await fs.readFile(file, { encoding: 'utf8', signal })
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    try {
      return parseDocument(file, JSON.parse(bytes))
    } catch (error) {
      throw markDamaged(error instanceof SyntaxError ? new TodoDataError(file, '不是有效的 JSON') : error)
    }
  }
  // Rendering the response on every request keeps the count rule in one place:
  // the panel always receives the full list and both counts.
  async function render(todos) {
    return { todos, pending: todos.filter(todo => !todo.done).length }
  }
  async function commit(todos, signal) {
    signal?.throwIfAborted()
    await writeFileAtomic(file, JSON.stringify({ version: VERSION, todos }, null, 2) + '\n',
      { mode: 0o600, dirMode: 0o700 })
    return render(todos)
  }
  // The DSH writer lock serializes this process and any other writer of the
  // same document; the read inside the lock is what makes it a safe cycle.
  // Each holding call accepts the caller's cancellation signal, so a cancelled
  // tool call stops before it claims the lock or writes.
  const mutate = async (operation, { signal } = {}) => {
    signal?.throwIfAborted()
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    return withFileLock(file, async () => {
      if (damaged) throw damaged
      return commit(await operation(await read(signal)), signal)
    }, { waitMs: 5000 })
  }
  const locate = (todos, id) => {
    if (typeof id !== 'string' || !id) throw fail('待办标识无效。')
    const index = todos.findIndex(todo => todo.id === id)
    if (index < 0) throw fail('未找到该待办，请刷新后重试。', 404)
    return index
  }
  return {
    file,
    async list({ signal } = {}) { return render(await read(signal)) },
    async create(title, description, { signal } = {}) {
      const heading = requireTitle(title)
      const body = requireDescription(description)
      return mutate(todos => {
        if (todos.length >= MAX_TODOS) throw fail('最多保存 ' + MAX_TODOS + ' 条待办。', 409)
        const now = Date.now()
        return [...todos, { id: randomUUID(), title: heading, description: body, done: false, createdAt: now, updatedAt: now }]
      }, { signal })
    },
    async update(id, title, description, { signal } = {}) {
      const heading = requireTitle(title)
      const body = requireDescription(description)
      return mutate(todos => {
        const index = locate(todos, id)
        const current = todos[index]
        // An omitted description keeps the stored one, so a title-only edit is safe.
        const next = { ...current, title: heading, description: description === undefined || description === null
          ? current.description : body }
        if (next.title === current.title && next.description === current.description) return todos
        next.updatedAt = Date.now()
        return todos.map((item, at) => at === index ? next : item)
      }, { signal })
    },
    async setDone(id, done, { signal } = {}) {
      if (typeof done !== 'boolean') throw fail('完成状态无效。')
      return mutate(todos => {
        const index = locate(todos, id)
        if (todos[index].done === done) return todos
        return todos.map((item, at) => at === index ? { ...item, done, updatedAt: Date.now() } : item)
      }, { signal })
    },
    async remove(id, { signal } = {}) {
      return mutate(todos => {
        const index = locate(todos, id)
        return todos.filter((_, at) => at !== index)
      }, { signal })
    },
  }
}
