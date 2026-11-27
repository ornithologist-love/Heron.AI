export const BUILTIN_BUNDLES = ['@deepseek-ai/dsh-experimental-voice-input-bundle']

// Only reconcile defaults previously supplied by a payload. User-installed
// dependencies and explicit disables remain owned by the native plugin manager.
export function bundledPluginSelection(manifest = {}, shipped = []) {
  const defaults = [...BUILTIN_BUNDLES, ...shipped]
  const selected = new Set(manifest.dsh?.profile?.bundles ?? [])
  const applied = new Set(manifest.heronAi?.defaultBundles ?? [])
  const unavailable = new Set(manifest.heronAi?.unavailableBundles ?? [])
  for (const name of applied) {
    if (defaults.includes(name) || Object.hasOwn(manifest.dependencies ?? {}, name)) continue
    if (selected.delete(name)) unavailable.add(name)
  }
  for (const name of defaults) {
    if (!applied.has(name) || unavailable.delete(name)) selected.add(name)
    applied.add(name)
  }
  return { bundles: [...selected], metadata: {
    ...manifest.heronAi, defaultBundles: [...applied], unavailableBundles: [...unavailable],
  } }
}
