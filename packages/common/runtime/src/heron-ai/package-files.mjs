import path from 'node:path'

// Use the package's explicit file list for both payload bytes and build inputs.
// Directories remain traversable only when a listed top-level path can own them.
export function bundleFileIncluded(manifest, relative, directory = false) {
  relative = relative.replaceAll('\\', '/')
  if (!relative || relative === 'package.json') return true
  const parts = relative.split('/')
  if (parts.some(part => ['node_modules', '.git', '.work', '__pycache__'].includes(part)) || relative.endsWith('.pyc')) return false
  if (!manifest.files) return true
  if (!Array.isArray(manifest.files) || manifest.files.some(pattern => typeof pattern !== 'string' || !pattern || path.isAbsolute(pattern) || pattern.split('/').includes('..')))
    throw Error('Invalid plugin file list: ' + manifest.name)
  return manifest.files.some(pattern => {
    pattern = pattern.replace(/^\.\//, '').replace(/\/$/, '')
    return directory ? path.matchesGlob(parts[0], pattern.split('/')[0])
      : relative === pattern || relative.startsWith(pattern + '/') || path.matchesGlob(relative, pattern)
  })
}
