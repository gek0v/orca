// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AntigravityAccountSummary } from '../../../../shared/antigravity-account-types'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

import {
  findRecoveredCandidates,
  isAccountStrained,
  useAntigravityQuotaResetMonitor
} from './useAntigravityQuotaResetMonitor'
import { toast } from 'sonner'
import * as sessionRestart from '@/lib/antigravity-session-restart'
import * as accountsHook from './useAntigravityAccounts'
import * as clockHook from './useResetCountdownClock'

vi.mock('sonner', () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('@/lib/antigravity-session-restart', () => ({
  switchAntigravityAccountAndRestartSession: vi.fn().mockResolvedValue({ restarted: true })
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, params?: Record<string, string>) => {
    if (!params) {
      return fallback
    }
    let res = fallback
    for (const [k, v] of Object.entries(params)) {
      res = res.replace(`{{${k}}}`, v)
    }
    return res
  }
}))

const NOW = 1_700_000_000_000

function createMockRateLimits(overrides?: Partial<ProviderRateLimits>): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: {
      usedPercent: 0,
      windowMinutes: 300,
      resetsAt: NOW + 100_000,
      resetDescription: 'in 2h'
    },
    weekly: null,
    status: 'ok',
    ...overrides
  }
}

function createMockAccount(
  id: string,
  email: string,
  lastUsage?: ProviderRateLimits | null,
  alias?: string
): AntigravityAccountSummary {
  return {
    id,
    email,
    alias: alias ?? null,
    subject: `sub-${id}`,
    authMethod: 'oauth',
    createdAt: 1000,
    updatedAt: 2000,
    lastUsage: lastUsage ?? null,
    lastUsageAt: lastUsage ? NOW - 10_000 : null
  }
}

describe('isAccountStrained', () => {
  it('returns true if limits are null or undefined', () => {
    expect(isAccountStrained(null)).toBe(true)
    expect(isAccountStrained(undefined)).toBe(true)
  })

  it('returns true if status is error', () => {
    const limits = createMockRateLimits({ status: 'error' })
    expect(isAccountStrained(limits)).toBe(true)
  })

  it('returns true if session usedPercent is at or above threshold (default 80%)', () => {
    const limits80 = createMockRateLimits({
      session: { usedPercent: 80, windowMinutes: 300, resetsAt: NOW + 5000, resetDescription: '' }
    })
    const limits79 = createMockRateLimits({
      session: { usedPercent: 79, windowMinutes: 300, resetsAt: NOW + 5000, resetDescription: '' }
    })
    expect(isAccountStrained(limits80)).toBe(true)
    expect(isAccountStrained(limits79)).toBe(false)
  })

  it('respects custom strained threshold', () => {
    const limits60 = createMockRateLimits({
      session: { usedPercent: 60, windowMinutes: 300, resetsAt: NOW + 5000, resetDescription: '' }
    })
    expect(isAccountStrained(limits60, 50)).toBe(true)
    expect(isAccountStrained(limits60, 70)).toBe(false)
  })
})

describe('findRecoveredCandidates', () => {
  it('excludes active account ID', () => {
    const acc1 = createMockAccount(
      'acc1',
      'acc1@test.com',
      createMockRateLimits({
        session: { usedPercent: 95, windowMinutes: 300, resetsAt: NOW - 1000, resetDescription: '' }
      })
    )
    const candidates = findRecoveredCandidates([acc1], 'acc1', NOW)
    expect(candidates).toEqual([])
  })

  it('identifies inactive accounts that reached their reset timestamp', () => {
    const acc1 = createMockAccount(
      'acc1',
      'acc1@test.com',
      createMockRateLimits({
        session: { usedPercent: 95, windowMinutes: 300, resetsAt: NOW - 5000, resetDescription: '' }
      }),
      'Work Account'
    )
    const acc2 = createMockAccount(
      'acc2',
      'acc2@test.com',
      createMockRateLimits({
        session: {
          usedPercent: 90,
          windowMinutes: 300,
          resetsAt: NOW + 10_000,
          resetDescription: ''
        }
      }),
      'Personal Account'
    )

    const candidates = findRecoveredCandidates([acc1, acc2], 'active-id', NOW)
    expect(candidates).toHaveLength(1)
    expect(candidates[0].accountId).toBe('acc1')
    expect(candidates[0].label).toBe('Work Account')
  })
})

describe('useAntigravityQuotaResetMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(clockHook, 'useResetCountdownClock').mockReturnValue(NOW)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fires Sonner toast with [Switch] action when active account is strained and candidate recovers', async () => {
    const activeAcc = createMockAccount(
      'active-id',
      'active@test.com',
      createMockRateLimits({
        session: {
          usedPercent: 95,
          windowMinutes: 300,
          resetsAt: NOW + 100_000,
          resetDescription: ''
        }
      })
    )
    const recoveredAcc = createMockAccount(
      'recovered-id',
      'recovered@test.com',
      createMockRateLimits({
        session: { usedPercent: 90, windowMinutes: 300, resetsAt: NOW - 1000, resetDescription: '' }
      }),
      'Secondary'
    )

    vi.spyOn(accountsHook, 'useAntigravityAccounts').mockReturnValue({
      state: { accounts: [activeAcc, recoveredAcc], activeAccountId: 'active-id' },
      accounts: [activeAcc, recoveredAcc],
      activeAccount: activeAcc,
      getAccountById: (id) => (id === 'active-id' ? activeAcc : recoveredAcc)
    })

    const { result } = renderHook(() => useAntigravityQuotaResetMonitor())

    expect(result.current.readyAccountIds.has('recovered-id')).toBe(true)
    expect(toast.info).toHaveBeenCalledTimes(1)
    expect(toast.info).toHaveBeenCalledWith(
      expect.stringContaining('Secondary'),
      expect.objectContaining({
        action: expect.objectContaining({
          label: 'Switch'
        })
      })
    )

    // Verify switch action callback
    const toastCall = vi.mocked(toast.info).mock.calls[0]
    const action = toastCall[1]?.action as { label: string; onClick: () => void }
    expect(action).toBeDefined()
    action.onClick()
    expect(sessionRestart.switchAntigravityAccountAndRestartSession).toHaveBeenCalledWith({
      targetAccountId: 'recovered-id',
      target: { runtime: 'host' }
    })
  })

  it('does NOT fire toast if active account is healthy (<80%)', () => {
    const activeAcc = createMockAccount(
      'active-id',
      'active@test.com',
      createMockRateLimits({
        session: {
          usedPercent: 30,
          windowMinutes: 300,
          resetsAt: NOW + 100_000,
          resetDescription: ''
        }
      })
    )
    const recoveredAcc = createMockAccount(
      'recovered-id',
      'recovered@test.com',
      createMockRateLimits({
        session: { usedPercent: 90, windowMinutes: 300, resetsAt: NOW - 1000, resetDescription: '' }
      }),
      'Secondary'
    )

    vi.spyOn(accountsHook, 'useAntigravityAccounts').mockReturnValue({
      state: { accounts: [activeAcc, recoveredAcc], activeAccountId: 'active-id' },
      accounts: [activeAcc, recoveredAcc],
      activeAccount: activeAcc,
      getAccountById: (id) => (id === 'active-id' ? activeAcc : recoveredAcc)
    })

    const { result } = renderHook(() => useAntigravityQuotaResetMonitor())

    expect(result.current.readyAccountIds.has('recovered-id')).toBe(true)
    expect(toast.info).not.toHaveBeenCalled()
  })

  it('deduplicates: does not fire twice for the same resetsAt', () => {
    const activeAcc = createMockAccount(
      'active-id',
      'active@test.com',
      createMockRateLimits({
        session: {
          usedPercent: 95,
          windowMinutes: 300,
          resetsAt: NOW + 100_000,
          resetDescription: ''
        }
      })
    )
    const recoveredAcc = createMockAccount(
      'recovered-id',
      'recovered@test.com',
      createMockRateLimits({
        session: { usedPercent: 90, windowMinutes: 300, resetsAt: NOW - 1000, resetDescription: '' }
      })
    )

    vi.spyOn(accountsHook, 'useAntigravityAccounts').mockReturnValue({
      state: { accounts: [activeAcc, recoveredAcc], activeAccountId: 'active-id' },
      accounts: [activeAcc, recoveredAcc],
      activeAccount: activeAcc,
      getAccountById: (id) => (id === 'active-id' ? activeAcc : recoveredAcc)
    })

    const { rerender } = renderHook(() => useAntigravityQuotaResetMonitor())
    expect(toast.info).toHaveBeenCalledTimes(1)

    // Re-render does not duplicate
    rerender()
    expect(toast.info).toHaveBeenCalledTimes(1)
  })

  it('batches sleep recovery: fires only one toast when multiple accounts expire together', () => {
    const activeAcc = createMockAccount(
      'active-id',
      'active@test.com',
      createMockRateLimits({
        session: {
          usedPercent: 95,
          windowMinutes: 300,
          resetsAt: NOW + 100_000,
          resetDescription: ''
        }
      })
    )
    const acc1 = createMockAccount(
      'acc1',
      'acc1@test.com',
      createMockRateLimits({
        session: { usedPercent: 90, windowMinutes: 300, resetsAt: NOW - 5000, resetDescription: '' }
      })
    )
    const acc2 = createMockAccount(
      'acc2',
      'acc2@test.com',
      createMockRateLimits({
        session: { usedPercent: 90, windowMinutes: 300, resetsAt: NOW - 1000, resetDescription: '' }
      })
    )

    vi.spyOn(accountsHook, 'useAntigravityAccounts').mockReturnValue({
      state: { accounts: [activeAcc, acc1, acc2], activeAccountId: 'active-id' },
      accounts: [activeAcc, acc1, acc2],
      activeAccount: activeAcc,
      getAccountById: (id) => (id === 'active-id' ? activeAcc : id === 'acc1' ? acc1 : acc2)
    })

    renderHook(() => useAntigravityQuotaResetMonitor())
    expect(toast.info).toHaveBeenCalledTimes(1)
  })
})
