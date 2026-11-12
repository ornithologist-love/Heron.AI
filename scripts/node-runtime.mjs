import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Assemble the pinned runtime for local products too, not only release archives.
export async function bundleNode(root, output) {
  if (process.platform !== 'win32') return;
  const pin = JSON.parse(await fs.readFile(path.join(root, 'node-runtime.json'), 'utf8'));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const target = path.join(output, 'node');
  const installed = await fs.readFile(path.join(target, 'node.exe')).catch(error => {
    if (error.code !== 'ENOENT') throw error; return null;
  });
  if (installed && hash(installed) === pin.sha256 && await fs.stat(path.join(target, 'LICENSE')).catch(() => null)) return;
  let bytes = await fs.readFile(process.execPath);
  let license;
  if (hash(bytes) === pin.sha256) license = await fs.readFile(path.join(path.dirname(process.execPath), 'LICENSE'));
  else {
    const download = async suffix => {
      const response = await fetch(`https://nodejs.org/dist/${pin.version}/${suffix}`, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw Error('Pinned Node download failed: ' + response.status);
      return Buffer.from(await response.arrayBuffer());
    };
    bytes = await download(`${pin.platform}/node.exe`);
    if (hash(bytes) !== pin.sha256) throw Error('Pinned Node hash mismatch');
    license = await download('LICENSE');
  }
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'node.exe'), bytes);
  await fs.writeFile(path.join(target, 'LICENSE'), license);
}
