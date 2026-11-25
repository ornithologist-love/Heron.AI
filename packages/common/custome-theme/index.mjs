import { readFile } from 'node:fs/promises'

export const name = 'custome-theme'
export const inject = ['webServer']

const fonts = [
  'google-sans/latin.woff2',
  'google-sans/latin-ext.woff2',
  'ibm-plex-mono/latin-400.woff2',
  'ibm-plex-mono/latin-ext-400.woff2',
  'ibm-plex-mono/latin-500.woff2',
  'ibm-plex-mono/latin-ext-500.woff2',
]
const assets = [['fonts.css', 'text/css; charset=utf-8'], ...fonts.map(file => [file, 'font/woff2'])]

export function apply(ctx) {
  for (const [file, type] of assets) {
    const source = new URL('./assets/' + file, import.meta.url)
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/custome-theme/' + file,
      async resource(request) {
        const body = await readFile(source)
        return new Response(request.method === 'HEAD' ? null : body, {
          headers: { 'content-type': type, 'content-length': String(body.length), 'x-content-type-options': 'nosniff' },
        })
      },
    }))
  }
}
