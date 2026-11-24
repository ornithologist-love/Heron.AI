window.__ModuleLoader__.load({
  id: '@common/brand',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const inject = ['slots', 'theme', 'locale', 'configForms'];
    function apply(ctx) {
      const bootstrap = globalThis.__DSH_BRAND__;
      if (!bootstrap) throw new Error('BrandClient requires its host bootstrap.');
      const form = ctx.configForms.get(bootstrap.namespace);
      let profile = bootstrap.profile;
      let signature = JSON.stringify(profile);
      let tokensKey, languageKey, releaseTokens, releaseLanguage, releaseSlots;
      const listeners = new Set();
      const getSnapshot = () => profile;
      const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
      const useProfile = () => React.useSyncExternalStore(subscribe, getSnapshot);
      ctx.provide('brandPresentation', {
        getSnapshot, subscribe,
        set: value => form.set('profile', value),
        reset: () => form.unset('profile'),
      });

      function Logo({size, value}) {
        if (!value.logo) return null;
        const style = {width: size, height: size, flexShrink: 0, display: 'block'};
        return value.monochrome
          ? h('span', {role: 'img', 'aria-label': value.label, style: {...style,
            backgroundColor: 'var(--dsw-alias-label-primary)',
            mask: `url(${JSON.stringify(value.logo)}) center / contain no-repeat`,
            WebkitMask: `url(${JSON.stringify(value.logo)}) center / contain no-repeat`}})
          : h('img', {src: value.logo, alt: value.label, width: size, height: size,
            style: {...style, objectFit: 'contain'}});
      }
      const brandFont = "'Montserrat', var(--dsw-font-sans, sans-serif)";
      function Mark({size = 28, className}) {
        return h('span', {className}, h(Logo, {size, value: useProfile()}));
      }
      function Name() {
        const value = useProfile();
        return h('span', {style: {display: 'inline-flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap'}},
          value.title && h('span', {style: {fontFamily: brandFont, fontSize: 15, fontWeight: 600,
            letterSpacing: '0.02em', color: 'var(--dsw-alias-label-primary)'}}, value.title),
          value.subtitle && h('span', {style: {fontSize: 10, letterSpacing: 2, color: 'var(--dsw-alias-label-tertiary)'}}, value.subtitle));
      }
      function HeroMark({size = 28, className}) {
        const value = useProfile();
        const heroSize = value.heroMarkSize > 0 ? value.heroMarkSize : 84;
        return h('span', {className, style: {display: 'flex', flexDirection: 'column', alignItems: 'center',
          textAlign: 'center', padding: '12px 12px 24px', color: 'var(--dsw-alias-label-primary)'}},
          h(Logo, {size: heroSize, value}),
          value.title && h('span', {style: {fontFamily: brandFont, fontSize: 24, fontWeight: 600,
            letterSpacing: '0.04em', lineHeight: '32px', marginTop: 10}}, value.title),
          value.subtitle && h('span', {style: {fontSize: 9, fontWeight: 500, letterSpacing: 6, lineHeight: '18px', marginTop: 4,
            paddingLeft: 6, color: 'var(--dsw-alias-label-secondary)'}}, value.subtitle));
      }
      const ModelName = ({model}) => model.name;

      function sync() {
        const next = form.getSnapshot().value?.profile ?? bootstrap.profile;
        const nextSignature = JSON.stringify(next);
        if (releaseSlots !== undefined && nextSignature === signature) return;
        profile = next;
        signature = nextSignature;
        const tokens = profile.enabled ? profile.tokens : null;
        if (JSON.stringify(tokens) !== tokensKey) {
          releaseTokens?.();
          releaseTokens = tokens ? ctx.theme.overrideTokens('@common/brand', tokens) : undefined;
          tokensKey = JSON.stringify(tokens);
        }
        const language = profile.enabled ? profile.language : null;
        if (JSON.stringify(language) !== languageKey) {
          releaseLanguage?.();
          releaseLanguage = undefined;
          if (language) {
            const dispose = [ctx.locale.addLanguage({id: language.id, label: language.label, fallback: language.fallback})];
            for (const [namespace, dictionary] of Object.entries(language.dictionaries))
              dispose.push(ctx.locale.register(namespace, language.id, dictionary));
            releaseLanguage = () => { for (const release of dispose.reverse()) release(); };
          }
          languageKey = JSON.stringify(language);
        }
        if (profile.enabled && releaseSlots === undefined) {
          const dispose = [];
          for (const [name, component] of [['sidebar.brand.mark', Mark], ['sidebar.brand.name', Name],
            ['conversation.hero.brand.mark', HeroMark]]) {
            dispose.push(ctx.slots.inject(name, () => ctx.slots.register({name, id: 'common-brand-' + name, priority: -100}, component)));
          }
          if (profile.modelNameOnly) dispose.push(ctx.slots.inject('conversation.input.model.label', () =>
            ctx.slots.register({name: 'conversation.input.model.label', id: 'common-brand-model-name', priority: -100}, ModelName)));
          releaseSlots = () => { for (const release of dispose.reverse()) release(); };
        } else if (!profile.enabled) {
          releaseSlots?.();
          releaseSlots = undefined;
        }
        for (const listener of listeners) listener();
      }
      ctx.effect(() => {
        const unsubscribe = form.subscribe(sync);
        sync();
        return () => {
          unsubscribe(); releaseSlots?.(); releaseTokens?.(); releaseLanguage?.(); listeners.clear();
        };
      });
    }
    return {inject, apply};
  }
});
