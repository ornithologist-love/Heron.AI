import { prepareIntegrationOptions } from './integrations.mjs'

/**
 * Let each active business package fill the launch options it owns (for
 * example a signed-in identity). Runs after the host package; explicit values win.
 * @param {{ aspects: string[] }} options resolved launch options (mutated)
 */
export async function prepareAspectOptions(options) {
  await prepareIntegrationOptions(options)
}
