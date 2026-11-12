import z from '@deepseek-ai/schemastery';

// Neutral defaults: the consuming product passes its own profile.
const NEUTRAL_PROFILE = {enabled: false, label: '', logo: '', monochrome: false, title: 'Heron.AI', subtitle: '', harnessMark: true,
  heroMarkSize: 0, modelNameOnly: false, tokens: null, language: null};

// Native settings propagate accepted profile edits to all connected browsers.
export const Config = z.object({
  profile: z.object({
    enabled: z.boolean().default(true),
    label: z.string().default(''),
    logo: z.string().default(''),
    monochrome: z.boolean().default(false),
    title: z.string().default(''),
    subtitle: z.string().default(''),
    harnessMark: z.boolean().default(true),
    // Empty-state mark size with the title and subtitle beneath it; 0 keeps the native headline mark.
    heroMarkSize: z.number().default(0),
    // Composer model caption shows the model name without its provider.
    modelNameOnly: z.boolean().default(false),
    tokens: z.union([z.dict(z.object({light: z.string().required(), dark: z.string().required()})), z.const(null)]).default(null),
    language: z.union([z.object({
      id: z.string().required(), label: z.string().required(), fallback: z.string().required(),
      dictionaries: z.dict(z.dict(z.string())).default({}),
    }), z.const(null)]).default(null),
  }).default(NEUTRAL_PROFILE).volatile(),
  defaultTheme: z.string().default(''),
  defaultLocale: z.string().default(''),
  installed: z.boolean().default(false).volatile(),
  // The defaults last applied; changed defaults apply once more, still only where the user has no choice.
  appliedDefaults: z.string().default('').volatile(),
});

export const inject = ['settings', 'appReady'];
export async function apply(ctx, config) {
  const namespace = ctx.fiber.entry.options.id;
  ctx.effect(() => ctx.settings.configure({auto: false}, ctx.fiber));
  ctx.on('webserver/index-inject', table => {
    table.push({kind: 'global', name: '__DSH_BRAND__', value: {namespace, profile: config.profile.get()}});
    table.push({kind: 'script', placement: 'head', text: 'document.title = globalThis.__DSH_BRAND__.profile.title || globalThis.__DSH_BRAND__.profile.label || document.title'});
  });
  // Defaults never overwrite user preferences. Live brand changes do not write
  // theme/locale; the application remains their owner.
  if (config.defaultTheme || config.defaultLocale) ctx.effect(() => ctx.appReady.onReady(() => {
    void (async () => {
      const applied = JSON.stringify([config.defaultTheme, config.defaultLocale]);
      if (config.appliedDefaults.get() === applied) return;
      for (const [ns, preference] of [['ui-theme', config.defaultTheme], ['locale', config.defaultLocale]]) {
        const section = ctx.settings.describe({redactSecrets: true}).find(row => row.ns === ns);
        if (preference && section && !Object.hasOwn(section.user ?? {}, 'preference'))
          await ctx.settings.update(ns, {preference});
      }
      await ctx.settings.update(namespace, {installed: true, appliedDefaults: applied});
    })().catch(() => ctx.logger.warn('Brand defaults were not persisted; existing preferences are retained.'));
  }));
}
