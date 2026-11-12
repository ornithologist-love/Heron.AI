import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { enabledProductPackages } from './product-profile.mjs'

// A host implementation is contributed by an enabled package. The runtime
// owns validation and selection, without importing a particular distributor.
function profiles() {
  const result = new Map([['none', { hostPackage: null, aspects: [] }], ['ue', { hostPackage: null, aspects: [] }]])
  for (const { root, manifest } of enabledProductPackages.values()) {
    const defaults = manifest.heronAi?.defaultAspects ?? []
    if (!Array.isArray(defaults) || defaults.some(value => typeof value !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(value)))
      throw Error('Invalid contributed default aspects: ' + manifest.name)
    result.get('none').aspects.push(...defaults)
    for (const [id, profile] of Object.entries(manifest.heronAi?.hostProfiles ?? {})) {
      if (!/^[a-z][a-z0-9_-]*$/.test(id) || result.has(id) || typeof profile.entry !== 'string'
        || !Array.isArray(profile.aspects ?? []) || (profile.aspects ?? []).some(value => typeof value !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(value)))
        throw Error('Invalid or duplicate contributed host profile: ' + id)
      const file = path.resolve(root, profile.entry), relative = path.relative(root, file)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Host profile entry must stay inside its package')
      result.set(id, { hostPackage: pathToFileURL(file).href, hostPackageBundle: manifest.name, aspects: [...profile.aspects ?? []] })
    }
  }
  return result
}

/**
 * Resolve the host package and business packages for one launch.
 * @param {string} hostIntegration validated --host-integration value
 * @param {string[] | undefined} aspects explicit --config aspects; overrides the host default
 * @returns {{ hostPackage: string | null, aspects: string[] }}
 */
export function resolveHostProfile(hostIntegration, aspects) {
  const profile = profiles().get(hostIntegration)
  if (!profile) throw new Error('Invalid host integration')
  return { hostPackage: profile.hostPackage, hostPackageBundle: profile.hostPackageBundle,
    aspects: [...new Set(aspects ?? profile.aspects)].sort() }
}
