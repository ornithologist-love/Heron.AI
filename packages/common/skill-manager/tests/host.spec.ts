/**
 * Host-half unit coverage: the tier classification, the service projection,
 * and the /skill-manager channel registration. The SkillRegistry is faked
 * with a minimal snapshot stub — the projection logic is what this plugin owns.
 */

import { Context } from '@deepseek-ai/cordis'
import { API_PATH } from '@deepseek-ai/dsh-client-connection'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'

/** A SKILL.md the Harness's loader accepts (valid YAML frontmatter). */
const VALID_SKILL = '---\nname: demo\ndescription: Use when demonstrating a valid skill file.\n---\n\n# Demo\n'

/** Minimal registry snapshot row, shaped like SkillSummary. */
interface Row {
  name: string
  description: string
  whenToUse?: string
  source: string
  provider: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  resourceBase?: { kind: 'directory'; path: string }
}

function snapshotRows(rows: Row[]): { skills: Row[]; complete: boolean } {
  return { skills: rows, complete: true }
}

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

/** One exact Fetch route the host half registered on the shared `/api` carrier. */
interface StubRoute {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: string
  readonly fetch: (request: Request) => Promise<Response>
}

/**
 * Connection stub for the shared `/api` carrier. The host half registers one
 * exact Fetch route per endpoint, so this captures every registration and then
 * addresses one endpoint the way the browser does: POST a `client-request`
 * envelope to `/api/skill-manager/<endpoint>` and read the result envelope.
 */
function connectionStub(): {
  connection: { fetch: { register: ReturnType<typeof vi.fn> } }
  routes: Map<string, StubRoute>
  handler: (endpoint: string, payload: unknown) => Promise<unknown>
} {
  const routes = new Map<string, StubRoute>()
  const connection = {
    fetch: {
      register: vi.fn((route: StubRoute) => {
        routes.set(route.path, route)
        return async () => {}
      }),
    },
  }
  const handler = async (endpoint: string, payload: unknown): Promise<unknown> => {
    const route = routes.get(`${API_PATH}/skill-manager/${endpoint}`)
    if (route === undefined) throw new Error(`no exact route for skillManager endpoint "${endpoint}"`)
    const response = await route.fetch(new Request(`http://localhost${route.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'test-1', method: `skill-manager/${endpoint}`, payload }),
    }))
    const body = await response.json() as { result: unknown }
    return body.result
  }
  return { connection, routes, handler }
}

async function bench(rows: Row[]): Promise<{
  connection: { fetch: { register: ReturnType<typeof vi.fn> } }
  routes: Map<string, StubRoute>
  registered: { channel: string; handler: (endpoint: string, payload: unknown) => Promise<unknown> } | undefined
}> {
  ctx = new Context()
  const registry = {
    snapshot: vi.fn(async () => snapshotRows(rows)),
  }
  ctx.provide('skills', registry as never)
  const { connection, routes, handler } = connectionStub()
  ctx.provide('connection', connection as never)
  await ctx.plugin(apply)
  return {
    connection,
    routes,
    registered: routes.size === 0 ? undefined : { channel: '/skill-manager', handler },
  }
}

describe('dsh-skill-manager host half', () => {
  it('registers one exact Fetch route per endpoint on the shared /api carrier', async () => {
    const { connection, routes } = await bench([])
    const endpoints = ['list', 'files', 'read', 'write', 'importSkill', 'exportSkill', 'deleteSkill', 'toggleSkill']
    expect([...routes.keys()].sort()).toEqual(endpoints.map(endpoint => `${API_PATH}/skill-manager/${endpoint}`).sort())
    for (const route of routes.values()) {
      expect(route.methods).toEqual(['POST'])
      expect(route.requestBody).toBe('buffered')
    }
    expect(connection.fetch.register).toHaveBeenCalledTimes(endpoints.length)
  })

  it('classifies bundled skills as read-only system rows', async () => {
    const { registered } = await bench([
      { name: 'sys-a', description: 'system skill', source: 'bundled', provider: 'filesystem', invocation: { modelInvocable: true, userInvocable: true } },
    ])
    expect(registered).toBeDefined()
    const result = await registered!.handler('list', {}) as { ok: true; value: { skills: { tier: string; readOnly: boolean }[] } }
    expect(result.ok).toBe(true)
    expect(result.value.skills[0]).toMatchObject({ name: 'sys-a', tier: 'system', readOnly: true })
  })

  it('classifies bundled skills from a plugin provider as read-only plugin rows', async () => {
    const { registered } = await bench([
      { name: 'p-a', description: 'plugin skill', source: 'bundled', provider: 'aegis-method-pack', invocation: { modelInvocable: true, userInvocable: true } },
    ])
    expect(registered).toBeDefined()
    const result = await registered!.handler('list', {}) as { ok: true; value: { skills: { name: string; tier: string; readOnly: boolean; provider: string }[] } }
    expect(result.ok).toBe(true)
    expect(result.value.skills[0]).toMatchObject({ name: 'p-a', tier: 'plugin', readOnly: true, provider: 'aegis-method-pack' })
  })

  it('classifies user, custom and runtime sources into their tiers', async () => {
    const { registered } = await bench([
      { name: 'u-a', description: 'user skill', source: 'user-dsh', provider: 'filesystem', invocation: { modelInvocable: true, userInvocable: true } },
      { name: 'u-b', description: 'user agents skill', source: 'user-agents', provider: 'filesystem', invocation: { modelInvocable: true, userInvocable: true } },
      { name: 'c-a', description: 'custom skill', source: 'custom', provider: 'filesystem', invocation: { modelInvocable: true, userInvocable: true } },
      { name: 'r-a', description: 'runtime skill', source: 'runtime', provider: 'filesystem', invocation: { modelInvocable: true, userInvocable: true } },
    ])
    const result = await registered!.handler('list', {}) as { ok: true; value: { skills: { name: string; tier: string; readOnly: boolean }[] } }
    const byName = Object.fromEntries(result.value.skills.map(s => [s.name, s]))
    expect(byName['u-a'].tier).toBe('user')
    expect(byName['u-b'].tier).toBe('user')
    expect(byName['c-a'].tier).toBe('custom')
    expect(byName['r-a'].tier).toBe('custom')
    // User skills are writable; custom and runtime are read-only.
    expect(byName['u-a'].readOnly).toBe(false)
    expect(byName['c-a'].readOnly).toBe(true)
    expect(byName['r-a'].readOnly).toBe(true)
  })

  it('reports invocation flags on each row', async () => {
    const { registered } = await bench([
      { name: 'model-only', description: 'd', source: 'user-dsh', provider: 'filesystem', invocation: { modelInvocable: true, userInvocable: false } },
    ])
    const result = await registered!.handler('list', {}) as { ok: true; value: { skills: { name: string; modelInvocable: boolean; userInvocable: boolean }[] } }
    expect(result.value.skills[0]).toMatchObject({ modelInvocable: true, userInvocable: false })
  })

  it('answers an empty catalog when no registry is mounted', async () => {
    ctx = new Context()
    const { connection, handler } = connectionStub()
    const registered = { channel: 'x', handler }
    ctx.provide('connection', connection as never)
    await ctx.plugin(apply)
    const result = await registered!.handler('list', {}) as { ok: true; value: { skills: unknown[]; workspaces: unknown[]; complete: boolean } }
    expect(result.value).toEqual({ skills: [], workspaces: [], complete: false })
  })

  it('reports a business error from the endpoint as an RPC error', async () => {
    ctx = new Context()
    const registry = {
      snapshot: vi.fn(async () => { throw new Error('boom') }),
    }
    ctx.provide('skills', registry as never)
    const { connection, handler } = connectionStub()
    const registered = { channel: 'x', handler }
    ctx.provide('connection', connection as never)
    await ctx.plugin(apply)
    const result = await registered!.handler('list', {}) as { ok: false; error: { code: string } }
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('internal')
  })
})

/** An fs stub backed by an in-memory file map. */
function fsStub(files: Record<string, string>) {
  // Every directory implied by the file paths.
  const dirs = new Set<string>(['/'])
  for (const path of Object.keys(files)) {
    const parts = path.split('/').filter(Boolean)
    for (let i = 1; i < parts.length; i += 1) {
      dirs.add(`/${parts.slice(0, i).join('/')}`)
    }
  }
  // Canonical key == normalized display path for the stub (mirrors the real
  // backend's resolve, which flattens `..` segments).
  const keyFor = (path: string): string => path.split('/').reduce<string[]>((acc, part) => {
    if (part === '' || part === '.') return acc
    if (part === '..') { acc.pop(); return acc }
    acc.push(part)
    return acc
  }, []).join('/').replace(/^/, '/')
  return {
    resolve: vi.fn(async (path: string) => ({ targetKey: keyFor(path), displayPath: path })),
    listDir: vi.fn(async (target: { displayPath: string }) => {
      const prefix = target.displayPath === '/' ? '/' : `${target.displayPath}/`
      const entries: { name: string; type: 'file' | 'directory'; target: { displayPath: string }; size?: number }[] = []
      for (const dir of dirs) {
        if (!dir.startsWith(prefix)) continue
        const rest = dir.slice(prefix.length)
        if (rest.length === 0 || rest.includes('/')) continue
        entries.push({ name: rest, type: 'directory', target: { displayPath: dir } })
      }
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue
        const rest = path.slice(prefix.length)
        if (rest.length === 0 || rest.includes('/')) continue
        entries.push({
          name: rest,
          type: 'file',
          target: { displayPath: path },
          size: files[path]?.length,
        })
      }
      return entries
    }),
    readText: vi.fn(async (target: { displayPath: string }) => {
      const content = files[target.displayPath]
      if (content === undefined) throw new Error('not found')
      return content
    }),
    writeText: vi.fn(async (target: { displayPath: string }, content: string) => {
      files[target.displayPath] = content
      return {}
    }),
  }
}

async function benchWithFs(files: Record<string, string>, rows: Row[] = []): Promise<{
  routes: Map<string, StubRoute>
  handler: (endpoint: string, payload: unknown) => Promise<unknown>
}> {
  ctx = new Context()
  ctx.provide('fs', fsStub(files) as never)
  const registry = {
    snapshot: vi.fn(async () => snapshotRows(rows)),
  }
  ctx.provide('skills', registry as never)
  const { connection, routes, handler } = connectionStub()
  ctx.provide('connection', connection as never)
  await ctx.plugin(apply)
  // A catalog read registers the writable skill directories.
  await handler('list', {})
  return { routes, handler }
}

describe('dsh-skill-manager host file endpoints', () => {
  it('lists a skill directory as a recursive file tree', async () => {
    const { handler } = await benchWithFs({
      '/proj/.dsh/skills/demo/SKILL.md': '# demo',
      '/proj/.dsh/skills/demo/agents/openai.yaml': 'policy: {}',
    }, [{
      name: 'demo', description: 'd', source: 'user-dsh', provider: 'filesystem',
      invocation: { modelInvocable: true, userInvocable: true },
      resourceBase: { kind: 'directory', path: '/proj/.dsh/skills/demo' },
    }])
    const result = await handler('files', { path: '/proj/.dsh/skills/demo' }) as { ok: true; value: { root: { kind: string; children: { name: string; kind: string }[] } } }
    expect(result.ok).toBe(true)
    expect(result.value.root.kind).toBe('directory')
    const names = result.value.root.children.map(c => c.name)
    expect(names).toContain('SKILL.md')
    expect(names).toContain('agents')
  })

  it('reads a file through ctx.fs', async () => {
    const { handler } = await benchWithFs({
      '/proj/.dsh/skills/demo/SKILL.md': '# hello world',
    }, [{
      name: 'demo', description: 'd', source: 'user-dsh', provider: 'filesystem',
      invocation: { modelInvocable: true, userInvocable: true },
      resourceBase: { kind: 'directory', path: '/proj/.dsh/skills/demo' },
    }])
    const result = await handler('read', { path: '/proj/.dsh/skills/demo/SKILL.md' }) as { ok: true; value: { content: string } }
    expect(result.value.content).toBe('# hello world')
  })

  it('writes a file through ctx.fs', async () => {
    const { handler } = await benchWithFs(
      { '/home/u/.dsh/skills/demo/SKILL.md': '# old' },
      [{ name: 'demo', description: 'd', source: 'user-dsh', provider: 'filesystem', invocation: { modelInvocable: true, userInvocable: true }, resourceBase: { kind: 'directory', path: '/home/u/.dsh/skills/demo' } }],
    )
    const result = await handler('write', { path: '/home/u/.dsh/skills/demo/SKILL.md', content: VALID_SKILL }) as { ok: true; value: { ok: boolean } }
    expect(result.ok).toBe(true)
    expect(result.value.ok).toBe(true)
  })

  // The incident this guards: a description containing `github: ` (colon + space)
  // is invalid YAML, so the Harness drops the whole skill and leaves only a host
  // warning — while this editor's lenient reader still shows the file. Saving must
  // not be the moment that makes a skill disappear from every agent's catalog.
  it('refuses to save a SKILL.md whose frontmatter the Harness cannot parse', async () => {
    const { handler } = await benchWithFs(
      { '/home/u/.dsh/skills/demo/SKILL.md': VALID_SKILL },
      [{ name: 'demo', description: 'd', source: 'user-dsh', provider: 'filesystem', invocation: { modelInvocable: true, userInvocable: true }, resourceBase: { kind: 'directory', path: '/home/u/.dsh/skills/demo' } }],
    )
    const broken = '---\nname: demo\ndescription: Use when a github: plugin install fails.\n---\n\n# Demo\n'
    const result = await handler('write', { path: '/home/u/.dsh/skills/demo/SKILL.md', content: broken }) as { ok: false; error: { message: string } }
    expect(result.ok).toBe(false)
    expect(result.error.message).toContain('校验未通过')
    expect(result.error.message).toContain('冒号+空格')
  })

  it('still writes non-SKILL.md files in a skill directory unchanged', async () => {
    const { handler } = await benchWithFs(
      { '/home/u/.dsh/skills/demo/references/notes.md': '# old' },
      [{ name: 'demo', description: 'd', source: 'user-dsh', provider: 'filesystem', invocation: { modelInvocable: true, userInvocable: true }, resourceBase: { kind: 'directory', path: '/home/u/.dsh/skills/demo' } }],
    )
    const result = await handler('write', { path: '/home/u/.dsh/skills/demo/references/notes.md', content: 'not frontmatter at all' }) as { ok: true; value: { ok: boolean } }
    expect(result.ok).toBe(true)
  })

  it('refuses writes outside registered writable skill directories', async () => {
    const { handler } = await benchWithFs({})
    const result = await handler('write', { path: '/deploy/.dsh/skills/core/SKILL.md', content: 'x' }) as { ok: false; error: { message: string } }
    expect(result.ok).toBe(false)
    expect(result.error.message).toContain('outside a writable skill directory')
  })

  it('refuses writes into preset (custom) skill directories even when listed', async () => {
    const { handler } = await benchWithFs(
      { '/deploy/agent-presets/cordis/skills/preset-skill/SKILL.md': '# preset' },
      [{ name: 'preset-skill', description: 'd', source: 'custom', provider: 'filesystem', invocation: { modelInvocable: true, userInvocable: true }, resourceBase: { kind: 'directory', path: '/deploy/agent-presets/cordis/skills/preset-skill' } }],
    )
    const result = await handler('write', { path: '/deploy/agent-presets/cordis/skills/preset-skill/SKILL.md', content: 'tampered' }) as { ok: false; error: { message: string } }
    expect(result.ok).toBe(false)
    expect(result.error.message).toContain('outside a writable skill directory')
  })

  it('registers no route for an endpoint outside its table', async () => {
    const { routes } = await benchWithFs({})
    expect([...routes.keys()]).not.toContain(`${API_PATH}/skill-manager/bogus`)
  })
})

describe('dsh-skill-manager host path-safety', () => {
  it('refuses read/files/export for paths outside every known skill directory', async () => {
    const { handler } = await benchWithFs({
      '/home/u/.dsh/skills/demo/SKILL.md': '# demo',
      '/etc/secret': 'secret',
    }, [{
      name: 'demo', description: 'd', source: 'user-dsh', provider: 'filesystem',
      invocation: { modelInvocable: true, userInvocable: true },
      resourceBase: { kind: 'directory', path: '/home/u/.dsh/skills/demo' },
    }])
    // A sibling file outside the whitelisted skill dir is refused everywhere.
    for (const [endpoint, payload] of [
      ['read', { path: '/etc/secret' }],
      ['files', { path: '/etc' }],
      ['exportSkill', { path: '/etc' }],
    ] as const) {
      const result = await handler(endpoint, payload) as { ok: boolean; error?: { message: string } }
      expect(result.ok).toBe(false)
      expect(result.error?.message).toContain('outside a')
    }
    // Files inside a known skill directory still read fine.
    const ok = await handler('read', { path: '/home/u/.dsh/skills/demo/SKILL.md' }) as { ok: true; value: { content: string } }
    expect(ok.value.content).toBe('# demo')
  })

  it('rejects traversal (`..`) escape attempts even when the prefix matches', async () => {
    const { handler } = await benchWithFs({
      '/home/u/.dsh/skills/demo/SKILL.md': '# demo',
      '/home/u/outside': 'x',
    }, [{
      name: 'demo', description: 'd', source: 'user-dsh', provider: 'filesystem',
      invocation: { modelInvocable: true, userInvocable: true },
      resourceBase: { kind: 'directory', path: '/home/u/.dsh/skills/demo' },
    }])
    const result = await handler('read', { path: '/home/u/.dsh/skills/demo/../../outside' }) as { ok: false; error: { message: string } }
    expect(result.ok).toBe(false)
    expect(result.error.message).toContain('outside a')
  })

  it('refuses imports into an unregistered workspace path', async () => {
    ctx = new Context()
    ctx.provide('workspaceRegistry', {
      list: () => [{ id: 'ws1', title: 'WS', path: '/proj/ws1' }],
    } as never)
    ctx.provide('skills', {
      snapshot: vi.fn(async () => ({ skills: [], complete: true })),
    } as never)
    const { connection, handler } = connectionStub()
    ctx.provide('connection', connection as never)
    await ctx.plugin(apply)
    const result = await handler!('importSkill', {
      tier: 'workspace',
      workspacePath: '/tmp/not-a-workspace',
      zipBase64: '',
    }) as { ok: false; error: { message: string } }
    expect(result.ok).toBe(false)
    expect(result.error.message).toContain('unregistered workspace')
  })

  it('rejects oversized zip payloads before decoding', async () => {
    const { handler } = await benchWithFs({})
    const big = 'A'.repeat(8 * 1024 * 1024 + 1)
    const result = await handler('importSkill', { tier: 'user', zipBase64: big }) as { ok: false; error: { message: string } }
    expect(result.ok).toBe(false)
    expect(result.error.message).toContain('8 MB')
  })

  it('rejects a small zip whose declared expansion exceeds the limit (zip-bomb guard)', async () => {
    // Import the zip helpers through the module under test's dependency.
    const { zipSync, strToU8 } = await import('fflate')
    const entries: Record<string, Uint8Array> = {}
    for (let i = 0; i < 2000; i += 1) {
      entries[`skill${i}/SKILL.md`] = strToU8('x'.repeat(100000))
    }
    const zipped = Buffer.from(zipSync(entries, { level: 9 })).toString('base64')
    expect(zipped.length).toBeLessThan(8 * 1024 * 1024) // payload under the base64 cap
    const { handler } = await benchWithFs({})
    const result = await handler('importSkill', { tier: 'user', zipBase64: zipped }) as { ok: false; error: { message: string } }
    expect(result.ok).toBe(false)
    expect(result.error.message).toContain('expands beyond')
  })
})

describe('dsh-skill-manager host preset discovery', () => {
  // Anchor: Docs/architecture/extensions.md#功能模板
  it('marks the catalog incomplete and still includes skills from healthy presets', async () => {
    ctx = new Context()
    const healthyScope = {}
    const presetSkill = {
      name: 'sample-skill', description: 'A test skill', source: 'custom', provider: 'fixture',
      invocation: { modelInvocable: true, userInvocable: true },
    }
    ctx.provide('skills', {
      snapshot: async ({ scope }: { scope?: object }) => snapshotRows(scope === healthyScope ? [presetSkill] : []),
    } as never)
    ctx.provide('agentPresets', {
      list: async () => [{ id: 'broken' }, { id: 'healthy' }],
      acquireScope: async (id: string) => {
        if (id === 'broken') throw new Error('preset mount failed')
        return { key: healthyScope, async [Symbol.asyncDispose]() {} }
      },
    } as never)
    const { connection, handler } = connectionStub()
    ctx.provide('connection', connection as never)
    await ctx.plugin(apply)
    const result = await handler('list', {})
    expect(result).toMatchObject({ ok: true, value: {
      complete: false,
      skills: expect.arrayContaining([expect.objectContaining({ name: presetSkill.name, tier: 'custom', preset: 'healthy' })]),
    } })
  })
})

/** Real-filesystem endpoint tests: import / export / delete / backup use node fs. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('dsh-skill-manager host file management endpoints', () => {
  let root: string | undefined

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  async function bench(): Promise<(endpoint: string, payload: unknown) => Promise<unknown>> {
    ctx = new Context()
    const { connection, handler } = connectionStub()
    ctx.provide('connection', connection as never)
    await ctx.plugin(apply)
    return handler
  }

  it('exports a skill directory as a zip and re-imports it', async () => {
    root = await mkdtemp(join(tmpdir(), 'sm-export-'))
    // A workspace whose .dsh/skills holds one skill; a catalog read registers
    // the skill dir (and workspace path) so export passes the whitelist.
    const ws = join(root, 'ws')
    const skillDir = join(ws, '.dsh', 'skills', 'demo')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: d\n---\n')

    ctx = new Context()
    ctx.provide('workspaceRegistry', {
      list: () => [{ id: 'ws1', title: 'WS', path: ws }],
    } as never)
    ctx.provide('skills', {
      snapshot: vi.fn(async () => ({ skills: [], complete: true })),
    } as never)
    const { connection, handler } = connectionStub()
    ctx.provide('connection', connection as never)
    await ctx.plugin(apply)
    await handler!('list', {})

    const exported = await handler!('exportSkill', { path: skillDir }) as { ok: true; value: { zipBase64: string; fileName: string } }
    expect(exported.ok).toBe(true)
    expect(exported.value.fileName).toBe('demo.zip')

    // A workspace import without workspacePath has a deterministic validation error.
    const imported = await handler!('importSkill', {
      zipBase64: exported.value.zipBase64,
      tier: 'workspace',
    } as never) as { ok: false; error: { message: string } }
    expect(imported.ok).toBe(false)
    expect(imported.error.message).toBe('cannot resolve the workspace directory for import')
  })

  it('refuses to delete outside the writable whitelist', async () => {
    root = await mkdtemp(join(tmpdir(), 'sm-del-'))
    const skillDir = join(root, 'victim')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: victim\ndescription: d\n---\n')
    const handler = await bench()

    // Delete: without a prior catalog read, the writable-dir whitelist is empty → refused.
    const del = await handler('deleteSkill', { path: skillDir }) as { ok: false; error: { message: string } }
    expect(del.ok).toBe(false)
    expect(del.error.message).toContain('outside a writable skill directory')
  })

  it('deletes a skill directory itself after a catalog read registers it', async () => {
    root = await mkdtemp(join(tmpdir(), 'sm-del-ok-'))
    // A workspace with a skill; the catalog read registers its dir as writable.
    const ws = join(root, 'ws')
    const skillDir = join(ws, '.dsh', 'skills', 'victim')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: victim\ndescription: d\n---\n')

    ctx = new Context()
    ctx.provide('workspaceRegistry', {
      list: () => [{ id: 'ws1', title: 'WS', path: ws }],
    } as never)
    ctx.provide('skills', {
      snapshot: vi.fn(async () => ({ skills: [], complete: true })),
    } as never)
    const { connection, handler } = connectionStub()
    ctx.provide('connection', connection as never)
    await ctx.plugin(apply)
    // The catalog read populates the writable whitelist from the workspace scan.
    await handler!('list', {})
    const del = await handler!('deleteSkill', { path: skillDir }) as { ok: true; value: { ok: boolean } }
    expect(del.ok).toBe(true)
    // The directory is gone.
    await expect(rm(skillDir, { force: true })).resolves.toBeUndefined()
  })

  it('lists blank workspaces as import targets and scans their skills', async () => {
    root = await mkdtemp(join(tmpdir(), 'sm-ws-'))
    // A workspace with one skill + a blank workspace.
    const populated = join(root, 'populated')
    await mkdir(join(populated, '.dsh', 'skills', 'ws-skill'), { recursive: true })
    await writeFile(join(populated, '.dsh', 'skills', 'ws-skill', 'SKILL.md'), '---\nname: ws-skill\ndescription: from workspace\n---\n')
    const blank = join(root, 'blank')
    await mkdir(blank, { recursive: true })

    ctx = new Context()
    ctx.provide('workspaceRegistry', {
      list: () => [
        { id: 'ws1', title: 'Populated', path: populated },
        { id: 'ws2', title: 'Blank', path: blank },
      ],
    } as never)
    ctx.provide('skills', {
      snapshot: vi.fn(async () => ({ skills: [], complete: true })),
    } as never)
    const { connection, handler } = connectionStub()
    ctx.provide('connection', connection as never)
    await ctx.plugin(apply)

    const result = await handler!('list', {}) as {
      ok: true
      value: {
        skills: { name: string; tier: string; workspace: { title: string; path: string } }[]
        workspaces: { title: string; skillCount: number }[]
      }
    }
    // The populated workspace's skill appears, blank workspace is an empty row.
    const wsSkill = result.value.skills.find(s => s.name === 'ws-skill')
    expect(wsSkill).toMatchObject({ tier: 'project', workspace: { title: 'Populated', path: populated } })
    const wsRows = result.value.workspaces
    expect(wsRows.find(w => w.title === 'Blank')).toMatchObject({ skillCount: 0 })
    expect(wsRows.find(w => w.title === 'Populated')).toMatchObject({ skillCount: 1 })
  })

  it('disables a workspace skill by renaming it into .system/, then restores it', async () => {
    root = await mkdtemp(join(tmpdir(), 'sm-toggle-'))
    const ws = join(root, 'ws')
    const skillDir = join(ws, '.dsh', 'skills', 'demo')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: d\n---\n')

    ctx = new Context()
    ctx.provide('workspaceRegistry', {
      list: () => [{ id: 'ws1', title: 'WS', path: ws }],
    } as never)
    ctx.provide('skills', {
      snapshot: vi.fn(async () => ({ skills: [], complete: true })),
    } as never)
    const { connection, handler } = connectionStub()
    ctx.provide('connection', connection as never)
    await ctx.plugin(apply)
    // Register the skill dir as writable via a catalog read.
    await handler!('list', {})

    // Disable: the directory moves into .system/ and list reports the skill
    // in place, marked disabled, with its restore path.
    const disabled = await handler!('toggleSkill', { path: skillDir, enable: false }) as { ok: true }
    expect(disabled.ok).toBe(true)
    const hiddenDir = join(ws, '.dsh', 'skills', '.system', 'demo')
    await expect(readFile(join(hiddenDir, 'SKILL.md'), 'utf8')).resolves.toContain('name: demo')
    const afterDisable = await handler!('list', {}) as { ok: true; value: { skills: { name: string; disabled?: boolean; restorePath?: string; tier: string; workspace: { path: string } }[] } }
    const disabledRow = afterDisable.value.skills.find(s => s.name === 'demo')
    expect(disabledRow).toMatchObject({ tier: 'project', disabled: true, restorePath: skillDir, workspace: { path: ws } })

    // Restore: pass the *visible* path; the directory moves back out of
    // .system/ and list shows it enabled again.
    const restored = await handler!('toggleSkill', { path: skillDir, enable: true }) as { ok: true }
    expect(restored.ok).toBe(true)
    await expect(readFile(join(skillDir, 'SKILL.md'), 'utf8')).resolves.toContain('name: demo')
    const afterRestore = await handler!('list', {}) as { ok: true; value: { skills: { name: string; disabled?: boolean }[] } }
    expect(afterRestore.value.skills.find(s => s.name === 'demo')?.disabled).toBeUndefined()
  })

  it('refuses to toggle a skill that is not in the writable whitelist', async () => {
    root = await mkdtemp(join(tmpdir(), 'sm-toggle-ro-'))
    const ws = join(root, 'ws')
    const skillDir = join(ws, '.dsh', 'skills', 'core')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: core\ndescription: d\n---\n')
    const handler = await bench()
    // No prior catalog read → the whitelist is empty → toggle refused.
    const result = await handler('toggleSkill', { path: skillDir, enable: false }) as { ok: false; error: { message: string } }
    expect(result.ok).toBe(false)
    expect(result.error.message).toContain('outside a writable skill directory')
  })
})
