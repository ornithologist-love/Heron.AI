// HERON_AI palettes join DSH's native theme registry in the browser (themes/client.js).
// This Host half publishes them and the saved choice, and paints the chosen
// palette before plugins start so a reload does not flash the native palette.
import z from '@deepseek-ai/schemastery'
import { HERON_AI_THEMES } from './themes/palettes.mjs'

export const name = 'heron-ai-theme-palettes'
export const inject = ['webServer', 'themeBootstrap']
export const Config = z.object({
  enabled: z.boolean().default(true),
  // Host-supplied follow choice: { id, label, queryParameter?, queryValues? }.
  external: z.any(),
})

export function apply(ctx, config) {
  ctx.on('webserver/index-inject', table => {
    const external = config.external ?? null
    table.push({ kind: 'global', name: '__HERON_AI_THEMES__', value: {
      themes: config.enabled ? HERON_AI_THEMES : [], external, ...ctx.themeBootstrap.current(),
    } })
    // Runs after DSH's own boot script, which already applied the native preference.
    table.push({ kind: 'script', placement: 'body', text: `(() => {
      const boot = globalThis.__HERON_AI_THEMES__
      const external = boot.external
      if (external?.queryParameter) {
        const mapped = external.queryValues?.[new URLSearchParams(location.search).get(external.queryParameter)]
        if (boot.themes.some(theme => theme.id === mapped)) external.id = mapped
      }
      const id = external && boot.followHost && !boot.theme ? external.id : boot.theme
      const theme = boot.themes.find(row => row.id === id)
      if (!theme) return
      for (const [name, value] of Object.entries(theme.tokens)) document.body.style.setProperty(name, value)
      document.body.toggleAttribute('data-ds-dark-theme', theme.colorScheme === 'dark')
      document.documentElement.style.colorScheme = theme.colorScheme
      document.documentElement.dataset.dsThemeSource = theme.id
    })()` })
  })
}
