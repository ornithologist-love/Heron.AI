import {createCapabilityService, wrapSessionSkillCatalog} from './service.mjs';
import z from '@deepseek-ai/schemastery';

export const Config = z.object({
  descriptors: z.array(z.any()).default([]),
});

export const inject = ['agents', 'systemPrompt', 'webServer', 'tools'];
export async function apply(ctx, config = {}) {
  const service = createCapabilityService(ctx, config.descriptors);
  ctx.provide('capabilities', service);
  ctx.inject(['sessionSkillCatalog', 'sessionController'], scoped => {
    scoped.effect(() => wrapSessionSkillCatalog(scoped.sessionSkillCatalog, service, {
      observeSession: (id, options) => scoped.sessionController.observe(id, options.signal),
    }));
  });
}
