// Document targets, excluding front matter and fenced code examples.
export function hasDocumentFragment(document, fragment) {
  let metadata = document.startsWith('---\n') || document.startsWith('---\r\n')
  let fence, width
  const lines = document.replace(/\r\n/g, '\n').split('\n').map((line, index) => {
    if (metadata) { if (index > 0 && line === '---') metadata = false; return '' }
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (marker && marker[1][0] === fence && marker[1].length >= width && !line.slice(marker[0].length).trim()) fence = undefined
      return ''
    }
    if (marker) { fence = marker[1][0]; width = marker[1].length; return '' }
    return line
  })
  const prose = lines.join('\n').replace(/<!--[\s\S]*?-->/g, '')
  for (const match of prose.replace(/`+[^`\n]*`+/g, '').matchAll(/<[a-z][^>]*\s(?:id|name)\s*=\s*(['"])(.*?)\1/gi))
    if (match[2] === fragment) return true
  if (/^L-\d{3}$/.test(fragment) && new RegExp(`(?<![\\w-])${fragment}(?![\\w-])`).test(prose)) return true
  const counts = new Map()
  const headings = prose.split('\n')
  for (let index = 0; index < headings.length; index++) {
    const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(headings[index])
    const title = heading?.[1] ?? (index + 1 < headings.length && /^ {0,3}(?:=+|-+)\s*$/.test(headings[index + 1]) ? headings[index].trim() : '')
    if (!title) continue
    const text = title.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/<[^>]*>|[`*~]/g, '')
    const slug = text.trim().toLowerCase().replace(/\s/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '')
    const count = counts.get(slug) ?? 0
    counts.set(slug, count + 1)
    if (text === fragment || (count ? `${slug}-${count}` : slug) === fragment) return true
  }
  return false
}
