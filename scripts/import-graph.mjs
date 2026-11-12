// Minimal ESM import scanner for the payload gate: returns every module specifier a file
// depends on, so the gate can walk the graph without executing anything.
//
// Only static specifiers are collected. Dynamic `import()` and `require()` are left out
// on purpose: they are resolved at run time and a missing one is a run-time failure, not
// a packaging regression, and including them would make the gate fail on optional loads.
//
// The scanner must never report a specifier that appears inside a comment, a string or a
// regular expression, because a false "missing module" would break the build for code that
// cannot even be reached. Comments and string/template literals are therefore skipped
// explicitly, and regex literals too: `origin.replace(/\/$/, '')` would otherwise be read as
// a division followed by the start of a string, and that string would never terminate.
const SINGLE = 0, DOUBLE = 1, TEMPLATE = 2

// A `/` starts a regex literal only where a value cannot continue the previous token:
// `a / b` is division, `(a)/b/` is not. `last` is the last significant character seen.
const regexAllowed = last => last == null || !/[A-Za-z0-9_$)\]]/.test(last)

/**
 * @param {string} source file contents
 * @param {string} file absolute file path, used for error messages
 * @returns {string[]} module specifiers, in source order, de-duplicated
 */
export function parseImports(source, file = '<input>') {
  const out = []
  const seen = new Set()
  const push = specifier => { if (!seen.has(specifier)) { seen.add(specifier); out.push(specifier) } }
  let i = 0
  const n = source.length
  let last = null // last significant character; decides regex vs division
  while (i < n) {
    const c = source[i]
    // comments
    if (c === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i)
      i = end === -1 ? n : end + 1
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    // regex literal, e.g. /\/$/ inside `origin.replace(/\/$/, '')`
    if (c === '/' && regexAllowed(last)) {
      i = skipRegex(source, i, file)
      last = 'x' // a regex is a value, so the next token cannot continue it
      continue
    }
    // strings and template literals
    if (c === '"' || c === "'" || c === '`') {
      const kind = c === '"' ? DOUBLE : c === "'" ? SINGLE : TEMPLATE
      i = skipString(source, i, kind, file)
      last = 'x'
      continue
    }
    if (!/\s/.test(c)) last = c
    if (c === 'i' && isBoundary(source[i - 1]) && source.startsWith('import', i) && isBoundary(source[i + 6])) {
      const rest = readStatement(source, i, file)
      for (const specifier of importSpecifiers(rest)) push(specifier)
      i += rest.length
      last = 'x'
      continue
    }
    if (c === 'e' && isBoundary(source[i - 1]) && source.startsWith('export', i) && isBoundary(source[i + 6])) {
      const rest = readStatement(source, i, file)
      for (const specifier of exportSpecifiers(rest)) push(specifier)
      i += rest.length
      last = 'x'
      continue
    }
    i++
  }
  return out
}

// Skips a regex literal body, honouring escapes and character classes so that `/[\/]/`
// and `/\//` terminate at the right slash.
function skipRegex(source, start, file) {
  let i = start + 1
  const n = source.length
  let inClass = false
  while (i < n) {
    const c = source[i]
    if (c === '\\') { i += 2; continue }
    if (c === '\n') throw new SyntaxError(`未闭合的正则：${file}`)
    if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (c === '/' && !inClass) {
      i++
      while (i < n && /[a-z]/.test(source[i])) i++ // flags
      return i
    }
    i++
  }
  throw new SyntaxError(`未闭合的正则：${file}`)
}

const isBoundary = c => c === undefined || !/[A-Za-z0-9_$]/.test(c)

// Reads up to the end of the statement (newline at depth 0 or a terminating semicolon),
// so `import`/`export` followed by a newline is handled without a full parser.
// Regex literals are skipped here for the same reason as in the main scan: an import
// statement is short, but a preceding token stream can leave `/` ambiguous and a slash
// inside a regex would otherwise open a string that never closes.
function readStatement(source, start, file) {
  let i = start
  const n = source.length
  let depth = 0
  let last = null
  while (i < n) {
    const c = source[i]
    if (c === '/' && source[i + 1] === '/') { const end = source.indexOf('\n', i); i = end === -1 ? n : end + 1; continue }
    if (c === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2); i = end === -1 ? n : end + 2; continue }
    if (c === '/' && regexAllowed(last)) { i = skipRegex(source, i, file); last = 'x'; continue }
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(source, i, c === '"' ? DOUBLE : c === "'" ? SINGLE : TEMPLATE, file)
      last = 'x'
      continue
    }
    if (c === '{' || c === '(' || c === '[') { depth++; last = c }
    else if (c === '}' || c === ')' || c === ']') { depth--; last = c }
    else if (c === ';' && depth <= 0) return source.slice(start, i + 1)
    else if (c === '\n' && depth <= 0) return source.slice(start, i)
    else { if (!/\s/.test(c)) last = c; }
    i++
  }
  return source.slice(start)
}

function skipString(source, start, kind, file) {
  let i = start + 1
  const n = source.length
  while (i < n) {
    const c = source[i]
    if (c === '\\') { i += 2; continue }
    if (kind === TEMPLATE && c === '$' && source[i + 1] === '{') {
      i = skipInterpolation(source, i + 2, file)
      continue
    }
    if ((kind === SINGLE && c === "'") || (kind === DOUBLE && c === '"') || (kind === TEMPLATE && c === '`')) return i + 1
    i++
  }
  throw new SyntaxError(`未闭合的字符串或模板：${file}`)
}

function skipInterpolation(source, start, file) {
  let i = start
  const n = source.length
  let depth = 1
  while (i < n) {
    const c = source[i]
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(source, i, c === '"' ? DOUBLE : c === "'" ? SINGLE : TEMPLATE, file)
      continue
    }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return i + 1 }
    i++
  }
  throw new SyntaxError(`未闭合的模板插值：${file}`)
}

// import x from 'm' | import 'm' | import { a } from 'm' | import * as ns from 'm'
function importSpecifiers(statement) {
  const out = []
  // side-effect import: import 'm'
  const bare = /^\s*import\s*(['"])([^'"]+)\1/.exec(statement)
  if (bare) return [bare[2]]
  // `from` clause, optionally preceded by a binding (possibly with braces)
  const from = /\bfrom\s*(['"])([^'"]+)\1/.exec(statement)
  if (from) out.push(from[2])
  else {
    // import { a } 'm' is invalid; but `import a, { b } from` already matched. A bare
    // `import m` without `from` has no specifier.
  }
  return out
}

// export { a } from 'm' | export * from 'm' | export * as ns from 'm'
function exportSpecifiers(statement) {
  const from = /\bfrom\s*(['"])([^'"]+)\1/.exec(statement)
  return from ? [from[2]] : []
}
