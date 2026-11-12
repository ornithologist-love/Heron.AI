import z from '@deepseek-ai/schemastery'

export const Config = z.object({ text: z.string().default('').volatile() })
export const inject = ['systemPrompt']

// The product supplies background text; workspace facts remain skill-owned.
export function apply(ctx, config) {
  ctx.systemPrompt.section({ name: 'common:background', order: 10200, text: () => config.text.get() })
}
