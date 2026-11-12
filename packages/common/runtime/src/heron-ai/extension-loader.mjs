import path from 'node:path'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

// Child processes can use the selected host's dependency tree while keeping
// an optional package's own relative modules and filesystem location intact.
const root = process.env.HERON_AI_RUNTIME_ROOT
if (root) {
  const parentURL = pathToFileURL(path.join(root, 'package.json')).href
  const require = createRequire(parentURL)
  registerHooks({ resolve(specifier, context, next) {
    if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes(':')) {
      try { require.resolve(specifier); return next(specifier, { ...context, parentURL }) }
      catch (error) { if (!['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes(error.code)) throw error }
    }
    return next(specifier, context)
  } })
}
