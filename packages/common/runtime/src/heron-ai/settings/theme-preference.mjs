import z from '@deepseek-ai/schemastery'
// DSH's own theme setting keeps light/dark/system; the HERON_AI choice lives here.
export const Config = z.object({
  followHost: z.boolean().default(true).volatile(),
  theme: z.string().default('').volatile(),
})
export const inject = ['settings']
export function apply(ctx, config) {
  ctx.effect(() => ctx.settings.configure({ auto: false }))
  ctx.provide('themeBootstrap', { current: () => ({ followHost: config.followHost.get(), theme: config.theme.get() }) })
}
