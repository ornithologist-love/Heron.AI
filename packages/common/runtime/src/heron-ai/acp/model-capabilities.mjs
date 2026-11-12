// Preserve the HeronAI catalog effort labels; no inference from model names.
export const EFFORT_LABELS = ['minimal', 'low', 'medium', 'high', 'max']

export function effortLadder(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter(label => EFFORT_LABELS.includes(label)))]
}

