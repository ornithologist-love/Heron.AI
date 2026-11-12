// Migrated from the original HeronAI selector.
export function fitMenuWidth(texts: string[], extra = 52, cap = 0) {
    let max = 0
    try {
      const ctx = document.createElement('canvas').getContext('2d')
      if (ctx) {
        ctx.font = '14px system-ui, -apple-system, "Segoe UI", sans-serif'
        for (const text of texts) max = Math.max(max, ctx.measureText(text).width)
      }
    } catch { max = 0 }
    if (!max) return '180px'
    const width = Math.ceil(max * 1.1) + extra
    return `${cap ? Math.min(width, cap) : width}px`
  }
