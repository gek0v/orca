import { describe, expect, it } from 'vitest'
import { createAntigravityContextUsage } from './antigravity-usage-types'

describe('createAntigravityContextUsage', () => {
  it('computes context percentage and estimated flag for standard 1M window', () => {
    const usage = createAntigravityContextUsage(104_858, 1_048_576)
    expect(usage.usedTokens).toBe(104_858)
    expect(usage.windowTokens).toBe(1_048_576)
    expect(usage.percentage).toBe(10)
    expect(usage.estimated).toBe(true)
    expect(usage.categories).toEqual([{ name: 'Input & Context', tokens: 104_858 }])
  })

  it('computes 50% usage for 512k tokens', () => {
    const usage = createAntigravityContextUsage(524_288, 1_048_576)
    expect(usage.usedTokens).toBe(524_288)
    expect(usage.windowTokens).toBe(1_048_576)
    expect(usage.percentage).toBe(50)
    expect(usage.estimated).toBe(true)
  })
})
