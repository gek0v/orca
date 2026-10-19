import { describe, expect, it, vi } from 'vitest'
import type { AntigravityAccountRecord } from '../../shared/antigravity-account-types'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'
import { selectAntigravityPoolAccount } from './antigravity-task-pool-selector'

function mockAccount(overrides: Partial<AntigravityAccountRecord> = {}): AntigravityAccountRecord {
  return {
    id: 'acc-1',
    email: 'test@example.com',
    subject: 'sub-1',
    authMethod: 'oauth',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides
  }
}

function mockRateLimits(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'antigravity',
    status: 'ok',
    updatedAt: 1000,
    error: null,
    session: null,
    weekly: null,
    ...overrides
  }
}

describe('selectAntigravityPoolAccount', () => {
  it('throws invalid_argument when vault has no accounts', () => {
    expect(() =>
      selectAntigravityPoolAccount({
        vault: { accounts: [] },
        getRateLimits: () => null
      })
    ).toThrowError(OrchestrationError)

    try {
      selectAntigravityPoolAccount({
        vault: { accounts: [] },
        getRateLimits: () => null
      })
    } catch (error) {
      expect(error).toBeInstanceOf(OrchestrationError)
      if (error instanceof OrchestrationError) {
        expect(error.code).toBe('invalid_argument')
        expect(error.message).toContain('No Antigravity accounts are configured in the Task Pool')
      }
    }
  })

  it('throws invalid_argument when no accounts have inTaskPool === true', () => {
    const acc1 = mockAccount({ id: 'acc-1', inTaskPool: false })
    const acc2 = mockAccount({ id: 'acc-2' })

    expect(() =>
      selectAntigravityPoolAccount({
        vault: { accounts: [acc1, acc2] },
        getRateLimits: () => null
      })
    ).toThrowError(/No Antigravity accounts are configured in the Task Pool/)
  })

  it('calculates bottleneck window correctly as min(100 - sessionUsed, 100 - weeklyUsed)', () => {
    // 5h bottleneck: 5h 70% used (30% free), weekly 20% used (80% free) -> headroom = 30
    const accSessionBottleneck = mockAccount({ id: 'acc-session-bottleneck', inTaskPool: true })
    const limitsSession = mockRateLimits({
      session: { usedPercent: 70, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: { usedPercent: 20, windowMinutes: 10080, resetsAt: null, resetDescription: null }
    })

    const result1 = selectAntigravityPoolAccount({
      vault: { accounts: [accSessionBottleneck] },
      getRateLimits: () => limitsSession
    })
    expect(result1.accountId).toBe('acc-session-bottleneck')
    expect(result1.headroom).toBe(30)

    // Weekly bottleneck: 5h 15% used (85% free), weekly 90% used (10% free) -> headroom = 10
    const accWeeklyBottleneck = mockAccount({ id: 'acc-weekly-bottleneck', inTaskPool: true })
    const limitsWeekly = mockRateLimits({
      session: { usedPercent: 15, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: { usedPercent: 90, windowMinutes: 10080, resetsAt: null, resetDescription: null }
    })

    const result2 = selectAntigravityPoolAccount({
      vault: { accounts: [accWeeklyBottleneck] },
      getRateLimits: () => limitsWeekly
    })
    expect(result2.accountId).toBe('acc-weekly-bottleneck')
    expect(result2.headroom).toBe(10)
  })

  it('selects the account with the highest bottleneck headroom', () => {
    // Acc A: 5h has 80% free (20% used), weekly has 10% free (90% used) -> Headroom = 10%
    // Acc B: 5h has 50% free (50% used), weekly has 50% free (50% used) -> Headroom = 50%
    const accA = mockAccount({ id: 'acc-a', inTaskPool: true })
    const accB = mockAccount({ id: 'acc-b', inTaskPool: true })

    const limitsMap: Record<string, ProviderRateLimits> = {
      'acc-a': mockRateLimits({
        session: { usedPercent: 20, windowMinutes: 300, resetsAt: null, resetDescription: null },
        weekly: { usedPercent: 90, windowMinutes: 10080, resetsAt: null, resetDescription: null }
      }),
      'acc-b': mockRateLimits({
        session: { usedPercent: 50, windowMinutes: 300, resetsAt: null, resetDescription: null },
        weekly: { usedPercent: 50, windowMinutes: 10080, resetsAt: null, resetDescription: null }
      })
    }

    const result = selectAntigravityPoolAccount({
      vault: { accounts: [accA, accB] },
      getRateLimits: (id) => limitsMap[id]
    })
    expect(result.accountId).toBe('acc-b')
    expect(result.headroom).toBe(50)
  })

  it('treats unprobed accounts optimistically with 100% headroom and triggers background probe', () => {
    const accProbed = mockAccount({ id: 'acc-probed', inTaskPool: true })
    const accUnprobed = mockAccount({ id: 'acc-unprobed', inTaskPool: true })
    const probeMock = vi.fn()

    const probedLimits = mockRateLimits({
      session: { usedPercent: 30, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: { usedPercent: 30, windowMinutes: 10080, resetsAt: null, resetDescription: null }
    })

    const result = selectAntigravityPoolAccount({
      vault: { accounts: [accProbed, accUnprobed] },
      getRateLimits: (id) => (id === 'acc-probed' ? probedLimits : null),
      onTriggerProbe: probeMock
    })

    expect(result.accountId).toBe('acc-unprobed')
    expect(result.headroom).toBe(100)
    expect(probeMock).toHaveBeenCalledWith('acc-unprobed')
  })

  it('does not throw when onTriggerProbe is omitted for unprobed accounts', () => {
    const acc = mockAccount({ id: 'acc-new', inTaskPool: true })
    const result = selectAntigravityPoolAccount({
      vault: { accounts: [acc] },
      getRateLimits: () => undefined
    })
    expect(result.accountId).toBe('acc-new')
    expect(result.headroom).toBe(100)
  })

  it('excludes accounts with status === rate-limited, failureKind === rate-limited, headroom <= 0, or 100% used in either window', () => {
    const accRateLimited = mockAccount({ id: 'acc-rl', inTaskPool: true })
    const accFailureKind = mockAccount({ id: 'acc-fk', inTaskPool: true })
    const accSessionFull = mockAccount({ id: 'acc-session-full', inTaskPool: true })
    const accWeeklyFull = mockAccount({ id: 'acc-weekly-full', inTaskPool: true })
    const accOverLimit = mockAccount({ id: 'acc-over', inTaskPool: true })
    const accValid = mockAccount({ id: 'acc-valid', inTaskPool: true })

    const rlRateLimited = mockRateLimits({
      session: { usedPercent: 10, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: { usedPercent: 10, windowMinutes: 10080, resetsAt: null, resetDescription: null }
    })
    Object.defineProperty(rlRateLimited, 'status', { value: 'rate-limited' })

    const limitsMap: Record<string, ProviderRateLimits> = {
      'acc-rl': rlRateLimited,
      'acc-fk': mockRateLimits({
        usageMetadata: { failureKind: 'rate-limited' },
        session: { usedPercent: 10, windowMinutes: 300, resetsAt: null, resetDescription: null },
        weekly: { usedPercent: 10, windowMinutes: 10080, resetsAt: null, resetDescription: null }
      }),
      'acc-session-full': mockRateLimits({
        session: { usedPercent: 100, windowMinutes: 300, resetsAt: null, resetDescription: null },
        weekly: { usedPercent: 20, windowMinutes: 10080, resetsAt: null, resetDescription: null }
      }),
      'acc-weekly-full': mockRateLimits({
        session: { usedPercent: 20, windowMinutes: 300, resetsAt: null, resetDescription: null },
        weekly: { usedPercent: 100, windowMinutes: 10080, resetsAt: null, resetDescription: null }
      }),
      'acc-over': mockRateLimits({
        session: { usedPercent: 105, windowMinutes: 300, resetsAt: null, resetDescription: null },
        weekly: { usedPercent: 20, windowMinutes: 10080, resetsAt: null, resetDescription: null }
      }),
      'acc-valid': mockRateLimits({
        session: { usedPercent: 80, windowMinutes: 300, resetsAt: null, resetDescription: null },
        weekly: { usedPercent: 80, windowMinutes: 10080, resetsAt: null, resetDescription: null }
      })
    }

    const result = selectAntigravityPoolAccount({
      vault: {
        accounts: [
          accRateLimited,
          accFailureKind,
          accSessionFull,
          accWeeklyFull,
          accOverLimit,
          accValid
        ]
      },
      getRateLimits: (id) => limitsMap[id]
    })

    expect(result.accountId).toBe('acc-valid')
    expect(result.headroom).toBe(20)
  })

  it('throws resource_exhausted with the earliest resetsAt timestamp when all accounts are exhausted', () => {
    const acc1 = mockAccount({ id: 'acc-1', inTaskPool: true })
    const acc2 = mockAccount({ id: 'acc-2', inTaskPool: true })

    const resetEarlier = 1770000000000
    const resetLater = 1770050000000

    const limitsMap: Record<string, ProviderRateLimits> = {
      'acc-1': mockRateLimits({
        session: {
          usedPercent: 100,
          windowMinutes: 300,
          resetsAt: resetLater,
          resetDescription: null
        },
        weekly: { usedPercent: 40, windowMinutes: 10080, resetsAt: null, resetDescription: null }
      }),
      'acc-2': mockRateLimits({
        session: {
          usedPercent: 100,
          windowMinutes: 300,
          resetsAt: resetEarlier,
          resetDescription: null
        },
        weekly: { usedPercent: 50, windowMinutes: 10080, resetsAt: null, resetDescription: null }
      })
    }

    try {
      selectAntigravityPoolAccount({
        vault: { accounts: [acc1, acc2] },
        getRateLimits: (id) => limitsMap[id]
      })
      expect.fail('Expected selectAntigravityPoolAccount to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(OrchestrationError)
      if (error instanceof OrchestrationError) {
        expect(error.code).toBe('resource_exhausted')
        expect(error.message).toContain(
          'All accounts in the Antigravity Task Pool have reached their usage limits'
        )
        expect(error.message).toContain(new Date(resetEarlier).toISOString())
        if (typeof error.data === 'object' && error.data !== null && 'resetsAt' in error.data) {
          expect(error.data.resetsAt).toBe(resetEarlier)
        }
      }
    }
  })

  it('breaks ties using lastUsedAt ascending (least recently used wins)', () => {
    const accA = mockAccount({ id: 'acc-a', inTaskPool: true, lastUsedAt: 2000 })
    const accB = mockAccount({ id: 'acc-b', inTaskPool: true, lastUsedAt: 1000 })

    const equalLimits = mockRateLimits({
      session: { usedPercent: 50, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: { usedPercent: 50, windowMinutes: 10080, resetsAt: null, resetDescription: null }
    })

    const result = selectAntigravityPoolAccount({
      vault: { accounts: [accA, accB] },
      getRateLimits: () => equalLimits
    })
    // accB has lastUsedAt: 1000 < accA (2000), so accB was used earlier (least recently used)
    expect(result.accountId).toBe('acc-b')
    expect(result.headroom).toBe(50)
  })

  it('breaks ties favoring accounts with no lastUsedAt (treated as 0)', () => {
    const accNeverUsed = mockAccount({ id: 'acc-never-used', inTaskPool: true })
    const accUsed = mockAccount({ id: 'acc-used', inTaskPool: true, lastUsedAt: 1000 })

    const result = selectAntigravityPoolAccount({
      vault: { accounts: [accUsed, accNeverUsed] },
      getRateLimits: () => null
    })
    expect(result.accountId).toBe('acc-never-used')
    expect(result.headroom).toBe(100)
  })
})
