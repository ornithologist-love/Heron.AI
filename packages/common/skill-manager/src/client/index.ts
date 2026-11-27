/**
 * Browser entry for the Skill Manager tab in Connectors.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { useSyncExternalStore } from 'react'
import type { ObservableSnapshot as HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'

/** Bind a bare observable to a uSES selector hook. Inlined: rc.8 made the renderer copy internal. */
function bindSnapshotSelector<T>(w: HostObservable<T>): SnapshotSelectorHook<T> {
  const subscribe = (fn: () => void) => w.subscribe(fn)
  const getSnapshot = () => w.getSnapshot()
  return function useSelector<S>(sel: (s: T) => S, _eq?: (a: S, b: S) => boolean): S {
    return sel(useSyncExternalStore(subscribe, getSnapshot))
  }
}
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { SkillManagerPanel, type SkillManagerInjected } from './skill-manager-panel.tsx'
import { SkillManagerController, createSkillManagerStore } from './store.ts'
import { en, zh, type SkillManagerKey } from './locales.ts'

export type { SkillManagerInjected } from './skill-manager-panel.tsx'
export type { SkillManagerEntry, SkillManagerState } from './store.ts'
export type { SkillManagerKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'connectors.skills': { kind: 'single'; scope: 'root' }
  }

  interface LocaleNamespaceMap {
    /** The Skill Manager tab copy. */
    'skill-manager': SkillManagerKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'skill-manager'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection', 'uiSession']

/**
 * Register the Skill Manager tab when Connectors is available.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-skill-manager: dictionaries')

  const connection = ctx.get('connection') as unknown as ConnectionHandle
  // The sessions list snapshot carried `current` through 0.1.x; the 0.2 client
  // dropped it (selection belongs to the view owners) and the uiSession scope
  // adapter is the current binding's owner.
  const uiSession = ctx.get('uiSession') as
    | { adapter?: { current?: HostObservable<{ key?: string }> } }
    | undefined
  const store = createSkillManagerStore()
  const controller = new SkillManagerController(connection, store)
  const usePanel = bindSnapshotSelector(store)
  const t = ctx.locale.bind(NS)

  // The current session (when one exists) resolves the project tier's cwd and
  // the layered scope; without one the host reads the global layer alone.
  const currentSessionId = (): unknown => uiSession?.adapter?.current?.getSnapshot().key

  const injectProps = (): SkillManagerInjected => ({
    controller,
    usePanel,
    t,
    refresh: () => { void controller.refresh(currentSessionId()) },
    refreshSilent: () => { void controller.refresh(currentSessionId(), true) },
  })

  ctx.slots.inject('connectors.skills', () => ctx.slots.register({
    name: 'connectors.skills',
    locale: NS,
    inject: injectProps,
  }, SkillManagerPanel))
}
