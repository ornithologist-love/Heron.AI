import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { crc32 } from 'node:zlib'
import yauzl from 'yauzl'

export class AgentPluginImportError extends Error {
  name = 'AgentPluginImportError'
}

export const MAX_AGENT_PLUGIN_ZIP = 16 * 1024 * 1024
const MAX_TOTAL = 64 * 1024 * 1024
const MAX_ENTRIES = 2048
const invalidSegment = /[<>:"\\|?*\x00-\x1f\x7f\ufffd]|[. ]$|^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i
const reject = message => { throw new AgentPluginImportError(message) }

export function isSafeAgentPluginPath(relative) {
  return typeof relative === 'string' && relative.length <= 512
    && relative.split('/').every(name => name && name !== '.' && name !== '..' && !invalidSegment.test(name))
}

export function createAgentPluginFileBudget() {
  let count = 0, size = 0
  return {
    add(bytes) {
      size += bytes
      if (++count > MAX_ENTRIES || size > MAX_TOTAL) reject('插件超出上限（2,048 个条目或 64 MiB 解压内容）。')
    },
  }
}

function pathIndex() {
  const paths = new Map()
  return (relative, directory) => {
    if (!isSafeAgentPluginPath(relative)) reject('插件包含不安全的文件路径。')
    const parts = relative.split('/')
    for (let index = 1; index <= parts.length; index++) {
      const name = parts.slice(0, index).join('/')
      const key = name.normalize('NFC').toLowerCase()
      const leaf = index === parts.length
      const folder = !leaf || directory
      const previous = paths.get(key)
      if (previous && (previous.name !== name || !previous.folder || !folder || leaf && previous.explicit)) {
        reject('插件包含冲突或重复的文件路径。')
      }
      if (!previous || leaf) paths.set(key, { name, folder, explicit: leaf })
      if (paths.size > MAX_ENTRIES) reject('插件包含超过 2,048 个路径条目。')
    }
  }
}

function outside(root, file) {
  const relative = path.relative(root, file)
  return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
}

export async function copyAgentPluginDirectory(source, destination, {
  budget = createAgentPluginFileBudget(), filter = () => true,
} = {}) {
  if (!(await lstat(source)).isDirectory()) reject('插件目录必须是普通文件夹。')
  const root = await realpath(source)
  const register = pathIndex()
  const visit = async relative => {
    if (!isSafeAgentPluginPath(relative)) reject('插件包含不安全的文件路径。')
    const input = path.join(root, relative)
    const initial = await lstat(input)
    if (outside(root, await realpath(input)) || (!initial.isDirectory() && (!initial.isFile() || initial.nlink > 1))) {
      reject('插件目录包含链接或特殊文件。')
    }
    budget.add(initial.isDirectory() ? 0 : initial.size)
    register(relative, initial.isDirectory())
    if (!await filter(relative, initial.isDirectory(), input)) return
    const output = path.join(destination, relative)
    if (initial.isDirectory()) {
      await mkdir(output, { recursive: true })
      for (const name of await readdir(input)) await visit(relative + '/' + name)
    } else {
      const bytes = await readFile(input)
      if (bytes.length !== initial.size) reject('插件文件在读取时发生变化，请重新预览。')
      await writeFile(output, bytes, { flag: 'wx', mode: 0o600 | (initial.mode & 0o111) })
    }
  }
  await mkdir(destination, { recursive: true })
  for (const name of await readdir(root)) await visit(name)
}

export async function extractAgentPluginZip(bytes, destination) {
  if (bytes.byteLength > MAX_AGENT_PLUGIN_ZIP) reject('ZIP 压缩包超过 16 MiB。')
  let archive
  try {
    archive = await yauzl.fromBufferPromise(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
      lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true,
    })
    if (archive.entryCount > MAX_ENTRIES) reject('ZIP 包含超过 2,048 个条目。')
    const register = pathIndex()
    const budget = createAgentPluginFileBudget()
    const entries = []
    for await (const entry of archive.eachEntry()) {
      const directory = entry.fileName.endsWith('/')
      const relative = directory ? entry.fileName.slice(0, -1) : entry.fileName
      const mode = (entry.externalFileAttributes >>> 16) & 0o177777
      const type = mode & 0o170000
      const reparsePoint = (entry.externalFileAttributes & 0x400) !== 0
      if (reparsePoint || type && type !== (directory ? 0o040000 : 0o100000)) {
        reject('ZIP 包含符号链接或特殊文件。')
      }
      if (directory && entry.uncompressedSize !== 0) reject('ZIP 目录条目包含意外数据。')
      register(relative, directory)
      budget.add(entry.uncompressedSize)
      entries.push({ entry, relative, directory, mode })
    }
    await mkdir(destination, { recursive: true })
    for (const { entry, relative, directory, mode } of entries) {
      const output = path.join(destination, relative)
      if (directory) {
        await mkdir(output, { recursive: true })
        continue
      }
      const stream = await archive.openReadStreamPromise(entry)
      const chunks = []
      let size = 0
      let crc = 0
      for await (const chunk of stream) {
        size += chunk.length
        if (size > entry.uncompressedSize) reject('ZIP 解压大小与目录记录不符。')
        crc = crc32(chunk, crc)
        chunks.push(chunk)
      }
      if (size !== entry.uncompressedSize || crc !== entry.crc32) reject('ZIP 文件内容校验失败。')
      await mkdir(path.dirname(output), { recursive: true })
      await writeFile(output, Buffer.concat(chunks, size), { flag: 'wx', mode: 0o600 | (mode & 0o111) })
    }
  } catch (error) {
    if (error instanceof AgentPluginImportError) throw error
    if (/file name|filename|invalid relative|absolute path/i.test(error.message)) reject('ZIP 包含不安全的文件路径。')
    reject('ZIP 文件损坏或包含不支持的条目。')
  } finally {
    archive?.close()
  }
}
