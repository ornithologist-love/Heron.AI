import fs from 'node:fs'
import path from 'node:path'

export function assertPublicPayload(host) {
  const content = path.join(host, 'heron-ai/content')
  const read = name => JSON.parse(fs.readFileSync(path.join(content, name), 'utf8'))
  if (read('bundled-plugins.json').length || Object.keys(read('product.json')).length
    || Object.keys(read('provider-catalog.json').providers ?? {}).length
    || Object.keys(read('mcp-config.json').mcpServers ?? {}).length)
    throw Error('Public payload contains optional deployment content')
  function walk(directory) {
    if (!fs.existsSync(directory)) return
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) { walk(file); continue }
      if (!entry.isFile()) throw Error('Public payload contains a non-file input')
      if (/\.(?:pem|crt|pfx|p12|key)$/i.test(entry.name)) throw Error('Public payload contains deployment certificate material: ' + path.relative(host, file))
      if (!/\.(?:json|mjs|js|yaml|yml|md|txt)$/.test(entry.name)) continue
      const text = fs.readFileSync(file, 'utf8')
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) throw Error('Public payload contains private key material')
      if (entry.name.endsWith('.json')) {
        let value; try { value = JSON.parse(text) } catch { continue }
        if (value?.algorithm === 'AES-256-GCM' && value?.ciphertext && value?.nonce)
          throw Error('Public payload contains a deployment credential envelope: ' + path.relative(host, file))
      }
    }
  }
  for (const scope of ['@common', '@heron-ai', '@host']) walk(path.join(host, 'node_modules', scope))
  console.log('[public-payload] No optional deployment content, credentials or certificates')
}
