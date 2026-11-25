import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const packageJson = JSON.parse(readFileSync(`${packageRoot}/package.json`, 'utf8')) as {
  dependencies?: Record<string, string>
  dsh?: { client?: { external?: unknown } }
}
const sourceStore = readFileSync(`${packageRoot}/src/client/store.ts`, 'utf8')
const clientArtifact = readFileSync(`${packageRoot}/lib/client.js`, 'utf8')
const runtimeClientSpecifier = '@deepseek-ai/dsh-client-runtime/client'

describe('client artifact runtime independence', () => {
  it('keeps the snapshot store implementation local to the plugin', () => {
    expect(sourceStore).toContain('function createSnapshotStore<T>')
    expect(sourceStore).toContain('export interface SnapshotStore<T>')
  })

  it('does not request the unavailable runtime client module', () => {
    expect(sourceStore).not.toContain(`from '${runtimeClientSpecifier}'`)
    expect(clientArtifact).not.toContain(`require(${JSON.stringify(runtimeClientSpecifier)})`)
  })

  it('does not declare the runtime client as a browser external', () => {
    expect(packageJson.dsh?.client?.external).toBeUndefined()
    expect(packageJson.dependencies?.['@deepseek-ai/dsh-client-runtime']).toBeUndefined()
    expect(packageJson.dependencies?.immer).toBe('^10.1.1')
  })
})
