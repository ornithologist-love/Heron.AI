// Presentation only: model families for the picker's brand mark and order.
// Never changes the model id sent to a provider and never implies capabilities.

/** Families in picker order; brands without an entry sort alphabetically after them. */
const FAMILY_ORDER = ['deepseek', 'claude', 'openai', 'kimi', 'zhipuai']

/**
 * Model family of a catalog id, or undefined when no bundled artwork matches.
 * Option values may carry a provider prefix (`<provider>/…`) and deployment
 * prefixes (`ext-`, `tokenhub_`); model ids never contain `/`.
 */
export function modelBrand(model) {
  const id = String(model).trim().toLowerCase().replace(/^(?:ext-|tokenhub_|[a-z0-9_-]+\/)/, '')
  if (/^(deepseek)(?:[-/_.\d]|$)/.test(id)) return 'deepseek'
  if (/^(openai[/:]|gpt(?:[-\d]|$)|chatgpt|o[134](?:[-.]|$)|codex)/.test(id)) return 'openai'
  if (/^(google[/:]|gemini|gemma)/.test(id)) return 'google'
  if (/^(anthropic[/:]|claude)/.test(id)) return 'claude'
  if (/^(hunyuan|hy[-_]?\d)/.test(id)) return 'hunyuan'
  if (/^(zhipu|zai[/:]|glm)/.test(id)) return 'zhipuai'
  if (/^(kimi|moonshot)/.test(id)) return 'kimi'
  if (/^minimax/.test(id)) return 'minimax'
  if (/^(xiaomi|mimo)/.test(id)) return 'xiaomi'
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/**
 * Order models by family (DeepSeek, Claude, GPT, Kimi, GLM first), then every
 * other model alphabetically by family — a model with no known family sorts by
 * its own name — and within a family by display name. Comparisons ignore case
 * and compare version numbers numerically.
 */
export function sortModelsByFamily(models) {
  const rank = model => {
    const brand = modelBrand(model.id)
    const index = FAMILY_ORDER.indexOf(brand)
    return index >= 0 ? [index, ''] : [FAMILY_ORDER.length, brand ?? model.name]
  }
  return models
    .map(model => ({ model, rank: rank(model) }))
    .sort((a, b) => a.rank[0] - b.rank[0] || collator.compare(a.rank[1], b.rank[1])
      || collator.compare(a.model.name, b.model.name))
    .map(entry => entry.model)
}
