// Product exclusions, independent of the pinned upstream SDK. Build tooling
// removes these packages and their unreferenced dependencies from every payload.
const excluded = new Set([
  '@deepseek-ai/dsh-office-to-pdf',
  '@deepseek-ai/dsh-skill-office',
  '@deepseek-ai/dsh-client-ui-settings-account',
  '@deepseek-ai/dsh-api-account-controller',
  '@deepseek-ai/dsh-deepseek-account',
  '@deepseek-ai/dsh-deepseek-account-platform',
  '@deepseek-ai/dsh-llm-deepseek-account',
  // Better Sidebar tree-shakes its SI/VSC icons into the client bundles.
  'react-icons',
])
export const excludedPackage = name => excluded.has(name) ||
  name.startsWith('@deepseek-ai/libreoffice-kit')

export const dependencyFields = ['dependencies', 'optionalDependencies', 'peerDependencies']
export function omitExcludedDependencies(manifest) {
  for (const field of [...dependencyFields, 'devDependencies', 'peerDependenciesMeta']) {
    if (!manifest[field]) continue
    for (const name of Object.keys(manifest[field])) if (excludedPackage(name)) delete manifest[field][name]
  }
  if (Array.isArray(manifest.dsh?.client?.inject))
    manifest.dsh.client.inject = manifest.dsh.client.inject.filter(name => !excludedPackage(name))
  return manifest
}
