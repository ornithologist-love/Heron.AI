import { randomInt } from 'node:crypto'
import { createServer } from 'node:net'

// The OS can allocate ports such as 6000 that fetch and browsers reject.
export async function findBrowserLoopbackPort() {
  for (let attempt = 0; attempt < 32; attempt++) {
    const port = randomInt(49152, 65536)
    const probe = createServer()
    try {
      await new Promise((resolve, reject) => {
        probe.once('error', reject)
        probe.listen(port, '127.0.0.1', resolve)
      })
      await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
      return port
    } catch (error) {
      if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error
    }
  }
  throw new Error('No free browser-compatible local port is available')
}
