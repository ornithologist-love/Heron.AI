import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Tests import @deepseek-ai/* for types and light runtime stubs (cordis
// Context, slot/locale fakes). devDependencies mirror the harness versions;
// the two browser-closure packages (dsh-client-runtime, dsh-api-remotes) are
// replaced with small test stubs because their npm artifacts load through
// window.__ModuleLoader__ and cannot run under vitest.
const STUBS = fileURLToPath(new URL('./tests/stubs/', import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: '@deepseek-ai/dsh-client-runtime/client', replacement: `${STUBS}dsh-client-runtime.ts` },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
  },
})
