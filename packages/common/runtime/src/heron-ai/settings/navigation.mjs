import z from '@deepseek-ai/schemastery'
export const Config = z.object({
  sessionId: z.string().volatile(),
  localMachineExpanded: z.boolean().default(true).volatile(),
  expandedMachines: z.dict(z.boolean()).default({}).volatile(),
})
export const inject = ['settings']
export function apply(ctx, config) {
  ctx.effect(() => ctx.settings.configure({ auto: false }))
  ctx.provide('sessionNavigationInput', { current: () => {
    const id = config.sessionId.get()
    return { sessionId: id,
      localMachineExpanded: config.localMachineExpanded.get(), expandedMachines: config.expandedMachines.get() }
  } })
}
