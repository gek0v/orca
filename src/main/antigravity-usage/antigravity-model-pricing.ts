type ModelRates = {
  input: number
  cached: number
  output: number
}

const GEMINI_FLASH_RATES: ModelRates = {
  input: 0.075,
  cached: 0.01875,
  output: 0.3
}

const GEMINI_PRO_RATES: ModelRates = {
  input: 1.25,
  cached: 0.3125,
  output: 5
}

const GEMINI_FLASH_LITE_RATES: ModelRates = {
  input: 0.0375,
  cached: 0.01,
  output: 0.15
}

export function resolveAntigravityModelRates(model: string | null): ModelRates {
  if (!model) {
    return GEMINI_FLASH_RATES
  }
  const normalized = model.toLowerCase()
  if (normalized.includes('lite') || normalized.includes('8b')) {
    return GEMINI_FLASH_LITE_RATES
  }
  if (normalized.includes('pro')) {
    return GEMINI_PRO_RATES
  }
  return GEMINI_FLASH_RATES
}

export function estimateAntigravityCostUsd(
  model: string | null,
  tokens: { inputTokens: number; cachedInputTokens: number; outputTokens: number }
): number | null {
  if (tokens.inputTokens === 0 && tokens.outputTokens === 0) {
    return null
  }
  const rates = resolveAntigravityModelRates(model)
  const uncachedInput = Math.max(0, tokens.inputTokens - tokens.cachedInputTokens)
  const cachedInput = Math.max(0, tokens.cachedInputTokens)
  const output = Math.max(0, tokens.outputTokens)

  const cost =
    (uncachedInput * rates.input + cachedInput * rates.cached) / 1_000_000 +
    (output * rates.output) / 1_000_000

  return Math.round(cost * 1_000_000) / 1_000_000
}
