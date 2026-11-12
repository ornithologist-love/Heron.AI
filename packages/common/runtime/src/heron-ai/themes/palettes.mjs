// HeronAi product colors from Client.Controls/Themes/ColorTokens.axaml.
// These are independent registered themes; DSH's built-in palettes remain intact.
function tokens(p) {
  const values = {
    'alias-bg-base': p.base, 'alias-bg-layer-1': p.surface,
    'alias-bg-layer-2': p.surface, 'alias-bg-layer-3': p.hover,
    'alias-bg-module-platform': p.subtle, 'alias-bg-overlay': p.surface,
    'alias-bg-multi-select': p.selected,
    'alias-label-primary': p.text, 'alias-label-primary-bluish': p.text,
    'alias-label-secondary': p.secondary, 'alias-label-tertiary': p.muted,
    'alias-label-caption': p.muted, 'alias-label-dimmed': p.disabled,
    'alias-label-primary-dimmed': p.disabled,
    'alias-label-primary-foreground': '#FFFFFF',
    'alias-border-l1': p.border, 'alias-border-l2': p.border,
    'alias-border-l2-darkmode-thin': p.border, 'alias-border-l3': p.borderStrong ?? p.strong,
    'alias-border-l4': p.borderStrong ?? p.strong,
    'alias-brand-primary': p.accent, 'alias-brand-primary-new-colorprimary-new-color': p.accent,
    'alias-brand-text': p.link, 'alias-link': p.link,
    'alias-state-business-primary': p.accent, 'alias-state-business-secondary': p.link, 'alias-state-business-tertiary': p.selected,
    'alias-button-info-fill': p.button, 'alias-button-info-hover': p.buttonHover,
    'alias-button-primary-fill': p.button, 'alias-button-primary-hover': p.buttonHover,
    'alias-button-primary-dimmed': p.selected,
    'alias-button-elevated-fill': p.surface, 'alias-button-floating-fill': p.surface,
    'alias-button-floating-hover': p.hover, 'alias-button-tool-bar-fill': p.subtle,
    'alias-button-tool-bar-hover': p.hover,
    'alias-button-ghost-active-fill': p.selected, 'alias-button-ghost-active-hover': p.hover,
    'alias-button-ghost-active-border': p.accent,
    'alias-interactive-bg-hover': p.hover, 'alias-interactive-bg-hover-solid': p.hover,
    'alias-interactive-bg-hover-accent': p.selected, 'alias-interactive-bg-active': p.selected,
    'alias-markdown-code-block': p.subtle, 'alias-markdown-code-block-banner': p.hover,
    'alias-markdown-inline-code': p.subtle,
    'alias-scrollbar-bg-l1': p.strong, 'alias-scrollbar-bg-l2': p.strong,
    'alias-scrollbar-hover-l1': p.muted, 'alias-scrollbar-hover-l2': p.muted,
    'specific-sidebar-fill': p.sidebar, 'specific-sidebar-nav-item-hover': p.hover,
    'specific-sidebar-nav-item-active': p.selected, 'specific-sidebar-nav-item-active-accent': p.selected,
    'specific-input-major': p.surface, 'specific-login-input': p.surface,
    'specific-menu': p.surface, 'specific-selector': p.surface,
    'specific-bubble': p.subtle, 'specific-bubble-highlight': p.selected,
  }
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [`--dsw-${key}`, value]))
}

export const HERON_AI_THEMES = [
  { id: 'heron-ai-warm-jade', label: 'Heron.AI · 暖玉', colorScheme: 'light', tokens: tokens({
    base: '#F8F9F6', surface: '#FFFFFF', subtle: '#F1F3EE', sidebar: '#F2F4EE',
    hover: '#F1F3EE', selected: '#E6EAE1', text: '#181B19', secondary: '#575D57',
    muted: '#737A72', disabled: '#9CA39A', border: '#E3E7E0', strong: '#CDD2C9',
    accent: '#28745B', link: '#28745B', button: '#28745B', buttonHover: '#22664F',
  }) },
  { id: 'heron-ai-ink-jade', label: 'Heron.AI · 墨玉', colorScheme: 'dark', tokens: tokens({
    base: '#242423', surface: '#2C2C2A', subtle: '#252524', sidebar: '#252524',
    hover: '#40403D', selected: '#40403D', text: '#EEEEEC', secondary: '#D8D8D4',
    muted: '#B8B8B2', disabled: '#92928C', border: '#3B3B38', borderStrong: '#3B3B38', strong: '#75756F',
    accent: '#07C160', link: '#92C5A7', button: '#28745B', buttonHover: '#22664F',
  }) },
]

