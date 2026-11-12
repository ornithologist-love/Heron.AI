// Seam patches: commits on top of the pinned official DSH commit. Packages they
// touch are compiled from source; every other package keeps its official artifact.
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const git = (directory, args) => execFileSync('git', ['-C', directory, ...args], {
  encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
}).trim()

/**
 * Resolve the DSH source identity and the official packages its seam patches change.
 * @param root - HeronAI project root.
 * @param lock - parsed config/dsh-artifacts.lock.json.
 * @returns the official commit, HEAD, the lock entries of patched packages, and the
 *   apps/web entry when the Web shell must be rebuilt from source.
 */
export async function dshPatchState(root, lock) {
  const source = JSON.parse(await fs.readFile(path.join(root, 'config/upstreams.json'), 'utf8')).sources.dsh
  const repository = path.resolve(root, source.directory)
  const head = git(repository, ['rev-parse', 'HEAD'])
  const official = source.upstreamCommit
  if (head !== official) {
    try { git(repository, ['merge-base', '--is-ancestor', official, head]) }
    catch { throw Error('DSH HEAD must be the official commit in config/upstreams.json or seam commits on top of it') }
  }
  const changed = head === official ? [] : git(repository, ['diff', '--name-only', official, head]).split(/\r?\n/).filter(Boolean)
  const patched = new Map()
  for (const file of changed) {
    // Repository documentation, gate scripts and their baselines, DSH's own
    // lockfile, its root test configuration and the root compiler aggregates
    // accompany seams but ship in no package.
    if (file.startsWith('docs/') || file.startsWith('scripts/') || file === 'vendor/README.md' || file === 'pnpm-lock.yaml' || file.startsWith('vitest.')
      || file.startsWith('tsconfig.') || file === 'tsconfig.json') continue
    const entry = lock.packages.filter(item => file.startsWith(item.directory + '/'))
      .sort((a, b) => b.directory.length - a.directory.length)[0]
    if (!entry) throw Error('DSH seam patches may only change published packages: ' + file)
    patched.set(entry.directory, entry)
  }
  // A package that imports another package's generated Remote face bundles a copy
  // of it, so it is rebuilt whenever the package owning that face is patched.
  for (const entry of [...patched.values()]) {
    const manifest = JSON.parse(await fs.readFile(path.join(repository, entry.directory, 'package.json'), 'utf8'))
    if (manifest.exports?.['./remote'] === undefined) continue
    let importers = ''
    try { importers = git(repository, ['grep', '-l', '-E', `^import [A-Za-z_$][A-Za-z0-9_$]* from '${manifest.name}/remote'`, '--', 'packages', 'apps']) }
    catch (error) { if (error.status !== 1) throw error }
    for (const file of importers.split(/\r?\n/).filter(file => file.includes('/src/'))) {
      const importer = lock.packages.filter(item => file.startsWith(item.directory + '/'))
        .sort((a, b) => b.directory.length - a.directory.length)[0]
      if (importer) patched.set(importer.directory, importer)
    }
  }
  // The Web shell links static libraries (their tsdown config calls staticLinked)
  // into the prebuilt apps/web bundle, so changing one rebuilds the shell itself.
  const shell = lock.packages.find(item => item.directory === 'apps/web')
  let rebuildShell = patched.delete('apps/web')
  for (const entry of patched.values()) {
    const config = await fs.readFile(path.join(repository, entry.directory, 'tsdown.config.ts'), 'utf8')
      .catch(error => { if (error.code === 'ENOENT') return ''; throw error })
    if (config.includes('staticLinked(')) rebuildShell = true
  }
  for (const entry of patched.values()) {
    if (git(repository, ['status', '--porcelain', '--', entry.directory]))
      throw Error('Commit seam patch changes before building: ' + entry.directory)
  }
  if (rebuildShell && git(repository, ['status', '--porcelain', '--', 'apps/web/src', 'apps/web/package.json', 'apps/web/vite.config.ts']))
    throw Error('Commit seam patch changes before building: apps/web')
  return { repository, official, head, patched: [...patched.values()], shell: rebuildShell ? shell : undefined }
}
