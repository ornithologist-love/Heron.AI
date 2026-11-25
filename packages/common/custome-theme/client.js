window.__ModuleLoader__.load({
  id: 'custome-theme',
  factory: () => {
    const TEXT_FONT_STACK =
      "'Google Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif"

    const CODE_FONT_STACKS = {
      darwin: "'IBM Plex Mono', 'SF Mono', Menlo, 'PingFang SC', 'Hiragino Sans GB'",
      win32: "Consolas, 'Cascadia Mono', 'Microsoft YaHei', 'PingFang SC'",
    }

    function detectPlatform() {
      if (document.documentElement?.dataset?.platform === 'darwin') {
        return 'darwin'
      }
      const uaPlatform =
        navigator?.userAgentData?.platform ||
        navigator?.platform ||
        navigator?.userAgent ||
        ''
      return /mac/i.test(uaPlatform) ? 'darwin' : 'win32'
    }

    function buildTokenOverrides(boostCodeSize) {
      const tokens = {
        '--dsw-alias-bg-base': { light: '#ffffff', dark: '#18191c' },
        '--dsw-specific-sidebar-fill': { light: '#f6f7f9', dark: '#141518' },
        '--dsw-specific-input-major': { light: '#ffffff', dark: '#202227' },
        '--dsw-alias-bg-layer-1': { light: '#ffffff', dark: '#1e2025' },
        '--dsw-alias-bg-layer-2': { light: '#f8f9fb', dark: '#22252b' },
        '--dsw-alias-border-l1': {
          light: 'rgba(15, 23, 42, 0.06)',
          dark: 'rgba(255, 255, 255, 0.06)',
        },
        '--dsw-alias-border-l2': {
          light: 'rgba(15, 23, 42, 0.09)',
          dark: 'rgba(255, 255, 255, 0.10)',
        },
        '--dsw-alias-border-l3': {
          light: 'rgba(15, 23, 42, 0.12)',
          dark: 'rgba(255, 255, 255, 0.14)',
        },
        '--dsw-alias-border-l4': {
          light: 'rgba(15, 23, 42, 0.16)',
          dark: 'rgba(255, 255, 255, 0.18)',
        },
        '--dsw-alias-markdown-code-block': { light: '#f5f7fa', dark: '#1b1d22' },
        '--dsw-alias-markdown-code-block-banner': {
          light: '#eef1f6',
          dark: '#23262d',
        },
        '--dsw-alias-markdown-inline-code': { light: '#eff2f7', dark: '#262932' },
        '--dsw-specific-bubble': { light: '#eef4ff', dark: '#242a36' },
        '--dsw-specific-bubble-highlight': { light: '#dbeafe', dark: '#2e384b' },
        '--dsw-specific-sidebar-nav-item-active': {
          light: 'rgba(15, 23, 42, 0.07)',
          dark: 'rgba(255, 255, 255, 0.10)',
        },
      }
      if (boostCodeSize) {
        tokens['--dsh-code-font-size'] = { light: '12px', dark: '12px' }
      }
      return tokens
    }

    function buildStyles(platform) {
      const codeFontStack = CODE_FONT_STACKS[platform] || CODE_FONT_STACKS.win32
      return `
:root {
  --dsh-font-family-text-default: ${TEXT_FONT_STACK};
  --dsh-font-family-code-default: ${codeFontStack};
  --dsw-radius-sm: 8px;
  --dsw-radius-md: 12px;
  --dsw-radius-lg: 14px;
  --dsw-radius-xl: 18px;
}

body {
  text-rendering: optimizeLegibility;
  --dsh-scrollbar-width: 6px;
  --dsw-shadow-lv1: 0 1px 3px rgba(15, 23, 42, 0.05), 0 1px 2px rgba(15, 23, 42, 0.03);
  --dsw-shadow-lv2: 0 6px 16px rgba(15, 23, 42, 0.06), 0 2px 6px rgba(15, 23, 42, 0.04);
  --dsw-shadow-lv3: 0 14px 36px rgba(15, 23, 42, 0.10), 0 4px 12px rgba(15, 23, 42, 0.05);
}

body,
body * {
  --dsw-elevation-panel:
    var(--dsw-elevation-stroke), 0 2px 10px rgba(15, 23, 42, 0.04), 0 0 18px rgba(15, 23, 42, 0.02);
  --dsw-elevation-soft:
    var(--dsw-elevation-stroke), 0 6px 20px rgba(15, 23, 42, 0.04), 0 1px 4px rgba(15, 23, 42, 0.03);
}

body[data-ds-dark-theme] {
  --dsw-shadow-lv1: 0 2px 6px rgba(0, 0, 0, 0.25);
  --dsw-shadow-lv2: 0 8px 20px rgba(0, 0, 0, 0.32);
  --dsw-shadow-lv3: 0 16px 40px rgba(0, 0, 0, 0.45);
}

h1, h2, h3 {
  letter-spacing: -0.015em;
}

blockquote {
  margin: 12px 0;
  padding: 8px 14px;
  border-left: 3px solid var(--dsw-alias-border-l4);
  background: var(--dsw-alias-bg-layer-2);
  border-radius: 0 var(--dsw-radius-sm) var(--dsw-radius-sm) 0;
}

:not(pre) > code {
  padding: 1px 5px;
  border-radius: 5px;
  border: 0.5px solid var(--dsw-alias-border-l1);
}

pre.shiki {
  border: 0.5px solid var(--dsw-alias-border-l1);
}
`
    }

    function apply(ctx) {
      const platform = detectPlatform()

      ctx.effect(() => {
        const fontLink = document.createElement('link')
        fontLink.rel = 'stylesheet'
        fontLink.dataset.plugin = 'custome-theme-fonts'
        fontLink.href = 'custome-theme/fonts.css'

        const styleTag = document.createElement('style')
        styleTag.dataset.plugin = 'custome-theme'
        styleTag.textContent = buildStyles(platform)

        document.head.append(fontLink, styleTag)
        return () => {
          fontLink.remove()
          styleTag.remove()
        }
      }, 'custome-theme: fonts and styles')

      let appliedBoost = null
      let disposeTokens = null

      const sync = (snapshot) => {
        const shouldBoost = (snapshot?.fontSizes?.code ?? 11) === 11
        if (shouldBoost === appliedBoost) return
        appliedBoost = shouldBoost
        disposeTokens = ctx.theme.overrideTokens(
          'custome-theme',
          buildTokenOverrides(shouldBoost),
        )
      }

      ctx.effect(() => {
        const unsubscribe = ctx.on('theme/change', sync)
        sync(ctx.theme.getTheme())
        return () => {
          unsubscribe?.()
          appliedBoost = null
          disposeTokens?.()
          disposeTokens = null
        }
      }, 'custome-theme: token overrides')
    }

    return { inject: ['theme'], apply }
  },
})
