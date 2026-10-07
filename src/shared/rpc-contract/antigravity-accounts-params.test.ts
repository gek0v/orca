import { describe, expect, it } from 'vitest'
import { AntigravityAccountUpdateParams } from './antigravity-accounts-params'

describe('AntigravityAccountUpdateParams', () => {
  it('accepts valid emoji strings up to 16 characters', () => {
    const parsed = AntigravityAccountUpdateParams.parse({
      target: { runtime: 'host' },
      accountId: 'acc-1',
      alias: 'Work',
      color: '#3b82f6',
      emoji: '🚀'
    })
    expect(parsed.emoji).toBe('🚀')
  })

  it('accepts null or undefined emoji', () => {
    const parsed = AntigravityAccountUpdateParams.parse({
      target: { runtime: 'host' },
      accountId: 'acc-1',
      emoji: null
    })
    expect(parsed.emoji).toBeNull()
  })

  it('rejects emoji exceeding 16 characters', () => {
    expect(() =>
      AntigravityAccountUpdateParams.parse({
        target: { runtime: 'host' },
        accountId: 'acc-1',
        emoji: 'a'.repeat(17)
      })
    ).toThrow()
  })
})
