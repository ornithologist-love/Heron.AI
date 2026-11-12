import { createApp, h, reactive, type Component } from 'vue'
import 'tdesign-vue-next/es/style/index.css'
import ProviderSettings from './DshProviderSettings.vue'
import FeatureTemplates from './DshFeatureTemplates.vue'
import SessionNavigation from './DshSessionNavigation.vue'
import componentStyles from './plugin-components.css?raw'

// Migrated components retain their original layout rules. The plugin maps
// their semantic colors to DSH; DSH is the only chat application.
const tag = document.createElement('style')
tag.dataset.plugin = '@heron-ai/dsh-widgets'
const widgetOverrides = `
  body{--td-brand-color:var(--dsw-alias-brand-primary);--td-brand-color-hover:var(--dsw-alias-button-primary-hover);--td-brand-color-active:var(--dsw-alias-brand-primary);--td-brand-color-light:var(--dsw-alias-interactive-bg-active);--shell-on-accent:#fff;--shell-surface:var(--dsw-alias-bg-base);--shell-surface-raised:var(--dsw-alias-interactive-bg-hover);--shell-text:var(--dsw-alias-label-primary);--shell-text-strong:var(--dsw-alias-label-primary);--shell-text-muted:var(--dsw-alias-label-secondary);--shell-text-faint:var(--dsw-alias-label-caption);--shell-border:var(--dsw-alias-border-l1);--shell-border-strong:var(--dsw-alias-border-l3);--shell-accent-soft:var(--dsw-alias-interactive-bg-hover);--shell-code-font:Consolas,monospace;--td-bg-color-container:var(--dsw-alias-bg-base);--td-text-color-primary:var(--dsw-alias-label-primary);--td-text-color-secondary:var(--dsw-alias-label-secondary);--td-component-border:var(--dsw-alias-border-l1)}
  .heron-ai-dsh-widget .context-button{border-radius:24px;height:28px;padding:0 8px;font:inherit;font-size:13px;font-weight:500}
  .heron-ai-dsh-widget .chevron{width:14px;height:14px;flex:none}
  .model-picker{background:var(--shell-surface);border-radius:14px}.model-credits,.model-multimodal{color:var(--shell-text-muted);background:var(--shell-accent-soft)}
  .credential-dialog input{box-sizing:border-box}.credential-overlay{z-index:1500}.credential-dialog{box-sizing:border-box}
  .model-list button:disabled{cursor:default}.t-popup .model-picker *{box-sizing:border-box}
`
tag.textContent = componentStyles + widgetOverrides
document.head.appendChild(tag)
if (import.meta.hot) {
  import.meta.hot.accept('./plugin-components.css?raw', module => {
    if (module) tag.textContent = module.default + widgetOverrides
  })
  import.meta.hot.dispose(() => tag.remove())
}

const components: Record<string, Component> = { providers: ProviderSettings, templates: FeatureTemplates, sessionNavigation: SessionNavigation }
export function mountWidget(element: HTMLElement, kind: string, props: Record<string, unknown>) {
  const values = reactive({ ...props })
  const component = components[kind]
  if (!component) throw Error('Unknown HERON_AI widget')
  const app = createApp({ render: () => h(component, values) })
  app.mount(element)
  return { update(next: Record<string, unknown>) { Object.assign(values, next) }, dispose() { app.unmount() } }
}
