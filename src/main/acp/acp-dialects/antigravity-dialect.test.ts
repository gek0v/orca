import { describe, expect, it } from 'vitest'
import {
  ANTIGRAVITY_ACP_DIALECT,
  collapseAntigravityModelEffort,
  isAntigravityIgnoredStdoutLine,
  resolveAntigravityModelEffortId
} from './antigravity-dialect'

describe('Antigravity ACP Dialect', () => {
  it('identifies known Chromium noisy stdout lines to ignore', () => {
    expect(isAntigravityIgnoredStdoutLine('Opening in existing browser session.')).toBe(true)
    expect(isAntigravityIgnoredStdoutLine('Opening in existing browser session.\r\n')).toBe(true)
    expect(isAntigravityIgnoredStdoutLine('{"jsonrpc":"2.0","method":"test"}')).toBe(false)
    expect(isAntigravityIgnoredStdoutLine('')).toBe(false)
  })

  it('collapses effort-qualified model IDs into canonical base IDs', () => {
    expect(collapseAntigravityModelEffort('gemini-3.8-flash-low')).toEqual({
      baseId: 'gemini-3.8-flash',
      effort: 'low'
    })
    expect(collapseAntigravityModelEffort('gemini-3.8-flash-medium')).toEqual({
      baseId: 'gemini-3.8-flash',
      effort: 'medium'
    })
    expect(collapseAntigravityModelEffort('gemini-3.8-flash-high')).toEqual({
      baseId: 'gemini-3.8-flash',
      effort: 'high'
    })
    expect(collapseAntigravityModelEffort('gemini-3.1-pro-low')).toEqual({
      baseId: 'gemini-3.1-pro',
      effort: 'low'
    })
    expect(collapseAntigravityModelEffort('gemini-pro-agent')).toEqual({
      baseId: 'gemini-3.1-pro',
      effort: 'high'
    })
    expect(collapseAntigravityModelEffort('custom-model')).toBeNull()
  })

  it('resolves base model ID and Orca effort tier to the advertised Antigravity model ID', () => {
    expect(resolveAntigravityModelEffortId('gemini-3.8-flash', 'low')).toBe('gemini-3.8-flash-low')
    expect(resolveAntigravityModelEffortId('gemini-3.8-flash', 'medium')).toBe(
      'gemini-3.8-flash-medium'
    )
    expect(resolveAntigravityModelEffortId('gemini-3.8-flash', 'high')).toBe(
      'gemini-3.8-flash-high'
    )
    expect(resolveAntigravityModelEffortId('gemini-3.1-pro', 'low')).toBe('gemini-3.1-pro-low')
    expect(resolveAntigravityModelEffortId('gemini-3.1-pro', 'high')).toBe('gemini-pro-agent')
    // Fallback if not effort-capable
    expect(resolveAntigravityModelEffortId('other-model', 'high')).toBe('other-model')
  })

  it('translates failed turn stop reasons and quota errors', () => {
    expect(ANTIGRAVITY_ACP_DIALECT.failedTurnText?.('rate_limit')).toContain('quota')
    expect(ANTIGRAVITY_ACP_DIALECT.failedTurnText?.('quota_exhausted')).toContain('quota')
    expect(ANTIGRAVITY_ACP_DIALECT.failedTurnText?.('error')).toBe('Turn failed')
  })

  it('determines context window accurately from models payload', () => {
    expect(
      ANTIGRAVITY_ACP_DIALECT.contextWindow?.({
        currentModelId: 'gemini-3.8-flash',
        availableModels: [{ modelId: 'gemini-3.8-flash' }]
      })
    ).toBe(1_048_576)

    expect(
      ANTIGRAVITY_ACP_DIALECT.contextWindow?.({
        currentModelId: 'gemini-3.1-pro',
        availableModels: [{ modelId: 'gemini-3.1-pro' }]
      })
    ).toBe(2_097_152)

    expect(
      ANTIGRAVITY_ACP_DIALECT.contextWindow?.({
        currentModelId: 'custom-model',
        availableModels: [{ modelId: 'custom-model', _meta: { totalContextTokens: 500_000 } }]
      })
    ).toBe(500_000)
  })

  it('wires ignoredStdoutLine into dialect', () => {
    expect(
      ANTIGRAVITY_ACP_DIALECT.ignoredStdoutLine?.('Opening in existing browser session.')
    ).toBe(true)
  })

  it('normalizes flat server model variants into base models and reasoning efforts', () => {
    const rawModels = {
      currentModelId: 'gemini-3.8-flash-high',
      availableModels: [
        { modelId: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low Reasoning)' },
        { modelId: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium Reasoning)' },
        { modelId: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High Reasoning)' },
        { modelId: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro (Low Reasoning)' },
        { modelId: 'gemini-pro-agent', name: 'Gemini 3.1 Pro (High Reasoning)' }
      ]
    }

    const result = ANTIGRAVITY_ACP_DIALECT.normalizeOptions?.({
      configOptions: [],
      models: rawModels
    })

    expect(result).toBeDefined()
    expect(result?.current).toEqual({
      model: 'gemini-3.8-flash',
      effort: 'high',
      confirmed: ['model', 'effort']
    })

    expect(result?.models).toHaveLength(2)
    const flash = result?.models.find((m) => m.id === 'gemini-3.8-flash')
    expect(flash).toBeDefined()
    expect(flash?.label).toBe('Gemini 3.8 Flash')
    expect(flash?.isDefault).toBe(true)
    expect(flash?.defaultEffort).toBe('high')
    expect(flash?.efforts).toEqual([
      { value: 'low', label: 'Low', description: 'Fast responses with minimal reasoning' },
      { value: 'medium', label: 'Medium', description: 'Balanced reasoning effort' },
      { value: 'high', label: 'High', description: 'Deep, extended reasoning' }
    ])

    const pro = result?.models.find((m) => m.id === 'gemini-3.1-pro')
    expect(pro).toBeDefined()
    expect(pro?.label).toBe('Gemini 3.1 Pro')
    expect(pro?.isDefault).toBe(false)
    expect(pro?.efforts).toEqual([
      { value: 'low', label: 'Low', description: 'Fast responses with minimal reasoning' },
      { value: 'high', label: 'High', description: 'Deep, extended reasoning' }
    ])
  })

  it('resolves option writes bidirectionally between Orca and Antigravity server', () => {
    const raw = {
      configOptions: [],
      models: {
        currentModelId: 'gemini-3.8-flash-medium',
        availableModels: [
          { modelId: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
          { modelId: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' },
          { modelId: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
          { modelId: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro (Low)' },
          { modelId: 'gemini-pro-agent', name: 'Gemini 3.1 Pro (High)' }
        ]
      }
    }

    // Changing effort from medium to low preserves base model (gemini-3.8-flash)
    const effortWrite = ANTIGRAVITY_ACP_DIALECT.resolveOptionWrite?.('effort', 'low', raw)
    expect(effortWrite).toEqual({
      method: 'model',
      modelId: 'gemini-3.8-flash-low'
    })

    // Changing model to gemini-3.1-pro preserves current effort (medium -> resolved to high variant)
    const modelWrite = ANTIGRAVITY_ACP_DIALECT.resolveOptionWrite?.('model', 'gemini-3.1-pro', raw)
    expect(modelWrite).toEqual({
      method: 'model',
      modelId: 'gemini-pro-agent'
    })
  })
})
