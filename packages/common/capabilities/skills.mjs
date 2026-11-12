import {createRequire} from 'node:module';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const inject = ['skills', 'capabilities'];

export function delegateSkillProvider(provider, capabilities) {
  return {
    name: provider.name,
    async list(options) {
      const observed = await provider.list(options);
      const filter = candidates => candidates.filter(candidate => capabilities.skillAllowed(candidate.name, options));
      return Array.isArray(observed) ? filter(observed) : {...observed, candidates: filter(observed.candidates)};
    },
    get(candidate, options) {
      return capabilities.skillAllowed(candidate.name, options) ? provider.get(candidate, options) : Promise.resolve(undefined);
    }
  };
}

// An optional discovery observer (registered by a business package through
// capabilities.observeSkillDiscovery) may report on these roots; without one the
// native provider is used unchanged.
export async function apply(ctx, {runtimeRoot, ...config}) {
  let provider, unsubscribe, unobserve, control, source, disposed = false;
  const roots = [...new Set([...(config.customSkillDirs ?? []), ...(config.bundledSkillDir ? [config.bundledSkillDir] : [])]
    .map(root => path.resolve(root)))];
  const warnings = {count: 0};
  const refresh = async () => {
    if (!provider || disposed) return;
    control.invalidate();
    await ctx.skills.list();
  };
  const attach = observer => {
    source?.dispose();
    source = observer?.attach(roots, refresh);
    control?.invalidate();
  };
  ctx.effect(() => async () => {
    disposed = true; unobserve?.(); source?.dispose(); unsubscribe?.(); await provider?.dispose();
  });
  unobserve = ctx.capabilities.onSkillDiscovery(attach);
  const requireRuntime = createRequire(path.join(runtimeRoot, 'package.json'));
  const {FileSystemSkillProvider} = await import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/dsh-skill-filesystem')).href);
  if (disposed) return;
  const nativeContext = {get: name => ctx.get(name), logger: {warn: (...args) => {warnings.count++; ctx.logger.warn(...args);}}};
  ctx.skills.registerProvider(nativeControl => {
    control = nativeControl;
    provider = new FileSystemSkillProvider(nativeContext, control, config);
    unsubscribe = ctx.capabilities.subscribe(control.invalidate);
    const observed = {
      name: provider.name,
      list: options => current().list(options),
      get: (candidate, options) => current().get(candidate, options),
    };
    const current = () => {
      const observer = ctx.capabilities.skillDiscovery();
      return observer && source ? observer.observe(provider, roots, source, warnings) : provider;
    };
    return delegateSkillProvider(observed, ctx.capabilities);
  });
  ctx.on('fs/observed', (target, _observation, actor) => {
    if (['write', 'edit'].includes(actor?.name)) provider?.observeHostMutation(target.displayPath);
  });
  await ctx.skills.list();
}
