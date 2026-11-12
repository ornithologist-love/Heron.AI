import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

// Git supplies the source inventory, including untracked files; actual bytes decide reuse.
// Generated outputs and dependencies remain outside the source inventory.
export function sourceInputs(root, paths) {
  const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...paths],
    { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw Error('Cannot enumerate component sources')
  return result.stdout.split('\0').filter(Boolean)
    .filter(file => !/(^|\/)(tests?|Docs|\.work)(\/|$)|(^|\/)README\.md$/i.test(file))
    .map(file => path.join(root, file)).filter(file => fs.existsSync(file) && fs.statSync(file).isFile())
}

export function outputFiles(root) {
  const files = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isSymbolicLink()) throw Error('Component output contains a link: ' + file)
    if (entry.isDirectory()) files.push(...outputFiles(file))
    else if (entry.isFile()) files.push(file)
  }
  return files
}

function digest(files, context) {
  const hash = createHash('sha256').update(context)
  for (const file of [...new Set(files)].sort()) hash.update(file).update('\0').update(fs.readFileSync(file)).update('\0')
  return hash.digest('hex')
}

export function buildReceipt(root, name, inputs, outputs, options = '') {
  const receipt = path.join(root, '.cache', 'components', createHash('sha256').update(name).digest('hex') + '.json')
  const context = options + ':node=' + process.version + ':platform=' + process.platform + ':arch=' + process.arch
  const input = digest(inputs(), context)
  const output = () => digest(outputs.flatMap(outputFiles), 'output')
  let reusable = false
  try {
    const previous = JSON.parse(fs.readFileSync(receipt, 'utf8'))
    reusable = previous.input === input && previous.output === output()
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
  }
  console.log(`[${reusable ? 'reuse' : 'build'}] ${name}: ${reusable ? 'inputs and output verified' : 'inputs changed or output missing/changed'}`)
  return { reusable, commit() {
    if (digest(inputs(), context) !== input) throw Error('Component sources changed during build; retry: ' + name)
    const value = JSON.stringify({ input, output: output() })
    fs.mkdirSync(path.dirname(receipt), { recursive: true })
    const temporary = receipt + '.' + process.pid + '.tmp'
    fs.writeFileSync(temporary, value)
    fs.renameSync(temporary, receipt)
  } }
}
