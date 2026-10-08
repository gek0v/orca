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
})
