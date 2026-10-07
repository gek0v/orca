import { describe, expect, it } from 'vitest'
import {
  estimateAntigravityCostUsd,
  resolveAntigravityModelRates
} from './antigravity-model-pricing'

describe('antigravity-model-pricing', () => {
  it('resolves flash rates by default or for flash models', () => {
    expect(resolveAntigravityModelRates(null)).toEqual({
      input: 0.075,
      cached: 0.01875,
      output: 0.3
    })
    expect(resolveAntigravityModelRates('Gemini 2.5 Flash')).toEqual({
      input: 0.075,
      cached: 0.01875,
      output: 0.3
    })
  })

  it('resolves pro rates for pro models', () => {
    expect(resolveAntigravityModelRates('Gemini 2.5 Pro')).toEqual({
      input: 1.25,
      cached: 0.3125,
      output: 5
    })
  })

  it('resolves lite rates for lite models', () => {
    expect(resolveAntigravityModelRates('Gemini 2.5 Flash Lite')).toEqual({
      input: 0.0375,
      cached: 0.01,
      output: 0.15
    })
  })

  it('estimates cost for flash tokens', () => {
    const cost = estimateAntigravityCostUsd('Gemini 2.5 Flash', {
      inputTokens: 1_000_000,
      cachedInputTokens: 200_000,
      outputTokens: 100_000
    })
    // (800k * 0.075 + 200k * 0.01875 + 100k * 0.3) / 1M = (0.06 + 0.00375 + 0.03) = 0.09375
    expect(cost).toBe(0.09375)
  })

  it('returns null if tokens are zero', () => {
    expect(
      estimateAntigravityCostUsd('Gemini 2.5 Flash', {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0
      })
    ).toBeNull()
  })
})
