/** Client-half unit coverage: what the browser half registers, and disposal. */

// @vitest-environment happy-dom

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

// The real components import ui-primitives icons (CSS Modules); the apply
// contract — a settings-section page whose body hosts the editor window — does
// not need them.
vi.mock('../src/client/skill-manager-panel.tsx', () => ({
  SkillManagerPanel: () => null,
}))
vi.mock('../src/client/skill-manager-editor.tsx', () => ({
  SkillManagerEditor: () => null,
}))

import { apply, inject } from '../src/client/index.ts'
import { groupByTier, groupByWorkspace, groupByPreset, groupByProvider } from '../src/client/store.ts'
import type { SkillManagerEntry } from '../src/client/store.ts'

/** Minimal slot registry stub: records registrations against declared slots. */
function slotStub() {
  const registered: { name: string; id?: string; order?: number }[] = []
  const declared = new Set(['settings.section'])
  return {
    registered,
    inject(name: string, fn: () => unknown) {
      if (!declared.has(name)) throw new Error(`slot "${name}" is not declared`)
      fn()
      return () => {}
    },
    register(options: { name: string; id?: string; order?: number }, _component: unknown) {
      registered.push({ name: options.name, id: options.id, order: options.order })
      return () => {}
    },
  }
}

describe('dsh-skill-manager client half', () => {
  it('registers the Skill Manager settings page', async () => {
    const ctx = new Context()
    const slots = slotStub()
    ctx.provide('slots', slots as never)
    ctx.provide('locale', { register: vi.fn(), bind: vi.fn(() => (key: string) => key) } as never)
    ctx.provide('connection', {
      isLoopback: true,
      rpc: { call: vi.fn() },
      api: {},
    } as never)
    ctx.provide('sessions', { list: { getSnapshot: () => ({ current: undefined }) } } as never)
    await ctx.plugin(apply)
    expect(inject).toContain('slots')
    expect(slots.registered).toHaveLength(1)
    const page = slots.registered[0]
    expect(page.name).toBe('settings.section')
    expect(page.id).toBe('skill-manager')
    expect(page.order).toBe(15)
    await ctx.fiber.dispose()
  })

  it('injects into declared slots only (undeclared slots fail loud)', async () => {
    const ctx = new Context()
    const slots = {
      inject(name: string, fn: () => unknown) {
        if (name !== 'settings.section' && name !== 'shell.overlay') {
          throw new Error(`slot "${name}" is not declared`)
        }
        fn()
        return () => {}
      },
      register: vi.fn(() => () => {}),
    }
    ctx.provide('slots', slots as never)
    ctx.provide('locale', { register: vi.fn(), bind: vi.fn(() => (key: string) => key) } as never)
    ctx.provide('connection', {
      isLoopback: true,
      rpc: { call: vi.fn() },
      api: {},
    } as never)
    ctx.provide('sessions', { list: { getSnapshot: () => ({ current: undefined }) } } as never)
    await expect(ctx.plugin(apply)).resolves.toBeDefined()
  })
})

describe('groupByTier', () => {
  it('buckets rows into system / user / project / custom / plugin', () => {
    const rows: SkillManagerEntry[] = [
      { name: 'a', description: 'd', tier: 'system', readOnly: true, provider: 'filesystem', modelInvocable: true, userInvocable: true },
      { name: 'b', description: 'd', tier: 'user', readOnly: false, provider: 'filesystem', modelInvocable: true, userInvocable: true },
      { name: 'c', description: 'd', tier: 'project', readOnly: false, provider: 'filesystem', modelInvocable: true, userInvocable: true },
      { name: 'd', description: 'd', tier: 'custom', readOnly: false, provider: 'filesystem', modelInvocable: true, userInvocable: true },
      { name: 'e', description: 'd', tier: 'plugin', readOnly: true, provider: 'aegis-method-pack', modelInvocable: true, userInvocable: true },
    ]
    const byTier = groupByTier(rows)
    expect(byTier.system.map(r => r.name)).toEqual(['a'])
    expect(byTier.user.map(r => r.name)).toEqual(['b'])
    expect(byTier.project.map(r => r.name)).toEqual(['c'])
    expect(byTier.custom.map(r => r.name)).toEqual(['d'])
    expect(byTier.plugin.map(r => r.name)).toEqual(['e'])
  })
})

describe('groupByWorkspace', () => {
  it('groups project rows under their workspace rows, blank workspaces last', () => {
    const rows: SkillManagerEntry[] = [
      { name: 'sys', description: 'd', tier: 'system', readOnly: true, provider: 'filesystem', modelInvocable: true, userInvocable: true },
      { name: 'pa', description: 'd', tier: 'project', readOnly: false, provider: 'filesystem', modelInvocable: true, userInvocable: true, workspace: { id: 'w1', title: 'Alpha', path: '/ws/alpha' } },
      { name: 'pb', description: 'd', tier: 'project', readOnly: false, provider: 'filesystem', modelInvocable: true, userInvocable: true, workspace: { id: 'w1', title: 'Alpha', path: '/ws/alpha' } },
      { name: 'pc', description: 'd', tier: 'project', readOnly: false, provider: 'filesystem', modelInvocable: true, userInvocable: true, workspace: { title: 'Beta', path: '/ws/beta' } },
    ]
    const groups = groupByWorkspace(rows, [
      { id: 'w1', title: 'Alpha', path: '/ws/alpha', skillCount: 2 },
      { id: 'w2', title: 'Blank', path: '/ws/blank', skillCount: 0 },
      { title: 'Beta', path: '/ws/beta', skillCount: 1 },
    ])
    expect(groups).toHaveLength(3)
    expect(groups[0]).toMatchObject({ title: 'Alpha', id: 'w1', path: '/ws/alpha' })
    expect(groups[0].skills.map(s => s.name)).toEqual(['pa', 'pb'])
    expect(groups[1]).toMatchObject({ title: 'Beta', path: '/ws/beta' })
    expect(groups[1].skills.map(s => s.name)).toEqual(['pc'])
    // Blank workspace appears last with no skills (import target).
    expect(groups[2]).toMatchObject({ title: 'Blank', path: '/ws/blank' })
    expect(groups[2].skills).toEqual([])
  })

  it('places project rows without workspace attribution under a fallback group', () => {
    const rows: SkillManagerEntry[] = [
      { name: 'p', description: 'd', tier: 'project', readOnly: false, provider: 'filesystem', modelInvocable: true, userInvocable: true },
    ]
    const groups = groupByWorkspace(rows)
    expect(groups).toHaveLength(1)
    expect(groups[0].title).toBe('project')
  })
})

describe('groupByPreset', () => {
  it('groups custom rows under their owning preset in first-seen order', () => {
    const rows: SkillManagerEntry[] = [
      { name: 'sys', description: 'd', tier: 'system', readOnly: true, provider: 'filesystem', modelInvocable: true, userInvocable: true },
      { name: 'ca', description: 'd', tier: 'custom', readOnly: true, provider: 'filesystem', modelInvocable: true, userInvocable: true, preset: 'cordis' },
      { name: 'cb', description: 'd', tier: 'custom', readOnly: true, provider: 'filesystem', modelInvocable: true, userInvocable: true, preset: 'cordis' },
      { name: 'cc', description: 'd', tier: 'custom', readOnly: true, provider: 'filesystem', modelInvocable: true, userInvocable: true, preset: 'test' },
      { name: 'uc', description: 'd', tier: 'custom', readOnly: true, provider: 'bundled-pack', modelInvocable: true, userInvocable: true },
    ]
    const groups = groupByPreset(rows)
    expect(groups).toHaveLength(3)
    expect(groups[0].id).toBe('cordis')
    expect(groups[0].skills.map(s => s.name)).toEqual(['ca', 'cb'])
    expect(groups[1].id).toBe('test')
    expect(groups[1].skills.map(s => s.name)).toEqual(['cc'])
    // A custom root outside every preset is grouped by its provider, not dropped.
    expect(groups[2].id).toBe('bundled-pack')
    expect(groups[2].skills.map(s => s.name)).toEqual(['uc'])
  })
})

describe('groupByProvider', () => {
  it('groups plugin rows under their owning provider in first-seen order', () => {
    const rows: SkillManagerEntry[] = [
      { name: 'sys', description: 'd', tier: 'system', readOnly: true, provider: 'filesystem', modelInvocable: true, userInvocable: true },
      { name: 'pa', description: 'd', tier: 'plugin', readOnly: true, provider: 'aegis-method-pack', modelInvocable: true, userInvocable: true },
      { name: 'pb', description: 'd', tier: 'plugin', readOnly: true, provider: 'aegis-method-pack', modelInvocable: true, userInvocable: true },
      { name: 'pc', description: 'd', tier: 'plugin', readOnly: true, provider: 'other-plugin', modelInvocable: true, userInvocable: true },
    ]
    const groups = groupByProvider(rows)
    expect(groups).toHaveLength(2)
    expect(groups[0].provider).toBe('aegis-method-pack')
    expect(groups[0].skills.map(s => s.name)).toEqual(['pa', 'pb'])
    expect(groups[1].provider).toBe('other-plugin')
    expect(groups[1].skills.map(s => s.name)).toEqual(['pc'])
  })
})
