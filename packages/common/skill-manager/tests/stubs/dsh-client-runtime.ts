/**
 * Minimal `@deepseek-ai/dsh-client-runtime/client` stand-in for unit tests.
 * The real npm artifact is a browser ModuleLoader closure (`window.__ModuleLoader__`)
 * and cannot load under vitest's node/happy-dom runner; the plugin only uses
 * `createSnapshotStore` from it, whose contract is small enough to mirror here.
 */

/** Snapshot store handle: read current state, subscribe, and mutate drafts. */
export interface SnapshotStore<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
  update(mutator: (draft: T) => void): void
  set(next: T): void
}

/** Build a snapshot store over an initial state (mirrors the runtime contract). */
export function createSnapshotStore<T>(init: T): SnapshotStore<T> {
  let state: T = init
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    update: (mutator) => {
      mutator(state)
      for (const listener of [...listeners]) listener()
    },
    set: (next) => {
      state = next
      for (const listener of [...listeners]) listener()
    },
  }
}
