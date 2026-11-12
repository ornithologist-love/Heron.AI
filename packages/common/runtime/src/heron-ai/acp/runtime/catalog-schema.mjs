import { effortLadder } from '../model-capabilities.mjs'
import { productProfile } from '../../product-profile.mjs'
const COMPAT_MAX_BYTES = 4096

export function validateCatalog(payload) {
  const models = []
  for (const item of Array.isArray(payload?.models) ? payload.models : []) {
    if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(item.id)) continue
    if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100) continue
    const model = { id: item.id, name: item.name }
    if (typeof item.credits === 'number' && Number.isFinite(item.credits) && item.credits >= 0)
      model.credits = item.credits
    for (const field of ['context_window', 'max_tokens']) {
      const value = item[field]
      if (Number.isInteger(value) && value > 0 && value <= 10_000_000) model[field] = value
    }
    if (item.reasoning === true) model.reasoning = true
    // Deployments may retain an older catalog schema independently of the client.
    // Canonical values win; aliases come from optional deployment content.
    const field = name => item[name] ?? item[productProfile.modelFieldAliases?.[name]]
    if (field('heron_ai_picked') === true) model.heron_ai_picked = true
    if (field('heron_ai_multimodal') === true) model.heron_ai_multimodal = true
    // A model the channel cannot serve for agent work is not offered at all: the
    // picker must never hand a user a route that fails on every send.
    if (field('heron_ai_agent_unsupported') === true) model.heron_ai_agent_unsupported = true
    const efforts = effortLadder(field('heron_ai_effort'))
    if (efforts.length) model.heron_ai_effort = efforts
    models.push(model)
  }
  if (!models.length || typeof payload?.default_model !== 'string' ||
      !models.some(item => item.id === payload.default_model)) return null
  const catalog = { models, default_model: payload.default_model }
  if (payload.base_url !== undefined) {
    if (typeof payload.base_url !== 'string' || !isHttpUrl(payload.base_url)) return null
    catalog.base_url = payload.base_url
  }
  if (payload.api !== undefined) {
    if (typeof payload.api !== 'string' || !/^[a-z0-9-]{1,40}$/.test(payload.api)) return null
    catalog.api = payload.api
  }
  if (payload.compat !== undefined) {
    if (!payload.compat || typeof payload.compat !== 'object' || Array.isArray(payload.compat)) return null
    if (JSON.stringify(payload.compat).length > COMPAT_MAX_BYTES) return null
    catalog.compat = payload.compat
  }
  return catalog
}

function isHttpUrl(value) {
  if (value.length > 300) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname
  } catch {
    return false
  }
}
