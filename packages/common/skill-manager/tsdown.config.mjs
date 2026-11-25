import { clientBundle } from './tsdown.client.ts'

const id = 'dsh-skill-manager'

// The harness clientBundle helper emits both halves: the node-side library
// (src/index.ts) as plain ESM, and the browser client
// bundle (src/client/index.ts) as the ModuleLoader closure with CSS Modules
// inlined by lightningcss. The node half keeps every @deepseek-ai dependency
// external — at runtime they resolve from the profile's node_modules (the
// dsh host process), exactly like dsh-mcp's lib/index.js.
export default clientBundle(id, ['src/index.ts'], {
  lib: {
    deps: {
      neverBundle: [/@deepseek-ai\//],
    },
  },
})
