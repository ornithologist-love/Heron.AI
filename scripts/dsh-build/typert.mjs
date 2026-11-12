import { WorkspaceAnalyzer, WorkspaceCaches } from '@deepseek-ai/dsh-typert-generator'

// These resources have no TypeScript API. Filter only the analyzer's in-memory
// manifest snapshot; installed manifests, source and generated modules stay intact.
function codeExports(value) {
  if (typeof value === 'string') return /\.(?:css|woff2?|ttf|otf|txt)$/iu.test(value) ? undefined : value
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    const entries = value.map(codeExports).filter(entry => entry !== undefined)
    return entries.length ? entries : undefined
  }
  const entries = Object.entries(value).flatMap(([key, target]) => {
    const filtered = codeExports(target)
    return filtered === undefined ? [] : [[key, filtered]]
  })
  return entries.length ? Object.fromEntries(entries) : undefined
}

/** Analyze product packages using the official generator and its public snapshot cache. */
export function analyzeProduct(options) {
  const caches = new WorkspaceCaches()
  const analyzer = new WorkspaceAnalyzer({ ...options, caches })
  // Populate registration snapshots without reading any package source.
  analyzer.discoverPackages(() => false)
  for (const registrations of caches.registrations.values()) {
    for (const registration of registrations) {
      registration.manifest.exports = codeExports(registration.manifest.exports)
    }
  }
  return analyzer.analyze()
}
