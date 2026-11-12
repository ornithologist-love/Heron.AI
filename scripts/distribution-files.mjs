// One file policy for copying dependencies and pruning older assembled payloads.
import fs from 'node:fs/promises'
import path from 'node:path'

function runtimeTargets(value) {
  if (typeof value === 'string') return [value]
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).filter(([key]) => !['types', 'typings'].includes(key))
    .flatMap(([, item]) => runtimeTargets(item))
}

export async function distributionFileContext(source, manifest) {
  const names = await fs.readdir(source)
  const entries = [manifest.main, manifest.module, manifest.bin, manifest.exports, manifest.imports].flatMap(runtimeTargets)
  const ptyPrebuild = manifest.name === 'node-pty' && process.platform === 'win32' && process.arch === 'x64'
    && !(await fs.stat(path.join(source, 'build/Release/conpty.node')).catch(() => null))
    && !(await fs.stat(path.join(source, 'build/Release/conpty_console_list.node')).catch(() => null))
    && (await Promise.all(['conpty.node', 'conpty_console_list.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']
      .map(file => fs.stat(path.join(source, 'prebuilds/win32-x64', file)).then(stat => stat.isFile(), () => false)))).every(Boolean)
  return { name: manifest.name, inspector: manifest.name.includes('inspector'),
    upstream: manifest.name.startsWith('@deepseek-ai/'), ptyPrebuild,
    hasLegalFile: names.some(name => /^(?:licen[cs]e|copying|copyright|notice)(?:\.|$)/i.test(name)),
    needsTsSource: entries.some(file => /(?<!\.d)\.(?:ts|tsx|mts|cts)$/.test(file)) }
}

export function discardDistributionFile(relative, context) {
  if (context.inspector || /(?:license|licence|copyright|notice|third[-_]?party)/i.test(path.posix.basename(relative))) return false
  const development = !context.upstream && (
    /\.d\.(?:ts|mts|cts)$/.test(relative)
    || (!context.needsTsSource && /^src\/.*\.(?:ts|tsx|mts|cts)$/.test(relative))
    || /^\.(?:yarn|github)\//.test(relative)
    || /^(?:changelog|history|contributing|code_of_conduct)(?:\.[^/]*)?$/i.test(relative)
    || (context.hasLegalFile && /^readme(?:\.[^/]*)?$/i.test(relative)))
  const windowsX64 = process.platform === 'win32' && process.arch === 'x64'
  const unusedPty = (context.ptyPrebuild && /^(?:third_party\/|build\/Release\/conpty\/)/.test(relative))
    || (context.name === 'node-pty' && (/\.pdb$/i.test(relative)
      || (windowsX64 && /^prebuilds\/win32-arm64\//.test(relative))))
  const mxcSdk = context.name === '@microsoft/mxc-sdk'
  const unusedMxc = mxcSdk && ((windowsX64 && /^bin\/arm64\//.test(relative))
    || (process.platform === 'win32' && /^bin\/x64\/(?:libmxc_ffi\.so|lxc-exec|unix-test-proxy)$/.test(relative))
    || /\.pdb$/i.test(relative))
  const screenshot = context.name === 'dsh-skill-manager' && /^assets\/(?:SKILLMANAGER|screenshot-en|screenshot-zh)\.png$/.test(relative)
  return development || unusedPty || unusedMxc || screenshot
}
