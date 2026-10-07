import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import {
  getCachedAntigravityAccountsState,
  setCachedAntigravityAccountsState,
  subscribeAntigravityAccountsState,
  updateCachedAccountUsage
} from '@/hooks/useAntigravityAccounts'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, string>) => {
    let result = fallback
    for (const [key, value] of Object.entries(values ?? {})) {
      result = result.replace(`{{${key}}}`, value)
    }
    return result
  }
}))

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => null
}))

type MockStoreState = {
  usagePercentageDisplay: 'used' | 'remaining'
  activeTabId: string | null
  tabsByWorktree: Record<string, { id: string; launchAgent?: string; launchAccountId?: string }[]>
}

let mockStoreState: MockStoreState = {
  usagePercentageDisplay: 'used',
  activeTabId: null,
  tabsByWorktree: {}
}

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: MockStoreState) => unknown) => selector(mockStoreState)
}))

const WEEKLY_MINUTES = 10_080

function weeklyWindow(usedPercent: number): RateLimitWindow {
  return { usedPercent, windowMinutes: WEEKLY_MINUTES, resetsAt: null, resetDescription: null }
}

/**
 * The record `agy -p "/usage"` produces for a tier metered weekly only, with the Gemini pool
 * genuinely exhausted — captured from agy 1.2.11.
 */
function antigravityLimits(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: weeklyWindow(100),
    buckets: [
      { name: 'Gemini Models', ...weeklyWindow(100) },
      { name: 'Claude and GPT models', ...weeklyWindow(0) }
    ],
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    ...overrides
  }
}

describe('Antigravity status-bar segment', () => {
  it('renders Gemini model pools as GM · WL and hides external Claude/GPT models from the status bar', async () => {
    // Why: Antigravity hides external model pools (Claude and GPT) from the status bar,
    // formatting first-party Gemini pools concisely as GM · WL / GM · 5H.
    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment p={antigravityLimits()} compact={false} display="used" mode="verbose" />
    )

    expect(markup).toContain('GM · WL')
    expect(markup).toContain('100%')
    expect(markup).not.toContain('Gemini Models')
    expect(markup).not.toContain('Claude and GPT models')
  })

  it('formats Gemini 5h and weekly limit buckets as GM · 5H and GM · WL', async () => {
    const { ProviderSegment } = await import('./StatusBar')
    const limits: ProviderRateLimits = {
      ...antigravityLimits(),
      buckets: [
        {
          name: 'Gemini Models · 5h Limit Remaining',
          usedPercent: 40,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: null
        },
        {
          name: 'Gemini Models · Weekly Limit Remaining',
          usedPercent: 25,
          windowMinutes: 10_080,
          resetsAt: null,
          resetDescription: null
        },
        {
          name: 'Claude and GPT models · Weekly Limit Remaining',
          usedPercent: 80,
          windowMinutes: 10_080,
          resetsAt: null,
          resetDescription: null
        }
      ]
    }
    const markup = renderToStaticMarkup(
      <ProviderSegment p={limits} compact={false} display="used" mode="verbose" />
    )

    expect(markup).toContain('GM · 5H')
    expect(markup).toContain('40%')
    expect(markup).toContain('GM · WL')
    expect(markup).toContain('25%')
    expect(markup).not.toContain('Gemini Models')
    expect(markup).not.toContain('Claude and GPT models')
    expect(markup).not.toContain('80%')
  })

  it('prioritizes Gemini models for tightest section in compact mode ignoring external models', async () => {
    const { ProviderSegment } = await import('./StatusBar')
    const limits: ProviderRateLimits = {
      ...antigravityLimits(),
      buckets: [
        {
          name: 'Gemini Models · Weekly Limit Remaining',
          usedPercent: 30,
          windowMinutes: 10_080,
          resetsAt: null,
          resetDescription: null
        },
        {
          name: 'Claude and GPT models',
          usedPercent: 95,
          windowMinutes: 10_080,
          resetsAt: null,
          resetDescription: null
        }
      ]
    }
    const markup = renderToStaticMarkup(
      <ProviderSegment p={limits} compact={true} display="used" mode="compact" />
    )

    expect(markup).toContain('30%')
    expect(markup).not.toContain('95%')
    expect(markup).not.toContain('Claude and GPT models')
  })

  it('shows the weekly window when a tier reports no session pool', async () => {
    // Why: the verbose fallback chain was `session ?? monthly`, so a weekly-only provider with a
    // real limit rendered an empty segment.
    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment
        p={antigravityLimits({ buckets: [] })}
        compact={false}
        display="used"
        mode="verbose"
      />
    )

    expect(markup).toContain('100%')
  })

  it('still renders a reading when only the weekly window is known', async () => {
    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment
        p={antigravityLimits({ buckets: undefined })}
        compact={false}
        display="used"
        mode="verbose"
      />
    )

    expect(markup).toContain('100%')
  })

  it('does not widen the allowlist for providers that rely on it', async () => {
    // Why: Gemini's experimental buckets are still filtered; only providers whose buckets are the
    // whole meter bypass the allowlist.
    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment
        p={{
          provider: 'gemini',
          session: weeklyWindow(12),
          weekly: null,
          buckets: [
            { name: 'Pro', ...weeklyWindow(30) },
            { name: 'Some Experimental Model', ...weeklyWindow(80) }
          ],
          updatedAt: Date.now(),
          error: null,
          status: 'ok'
        }}
        compact={false}
        display="used"
        mode="verbose"
      />
    )

    expect(markup).toContain('Pro')
    expect(markup).not.toContain('Some Experimental Model')
  })

  it('renders the active account alias and emoji next to the Antigravity icon', async () => {
    setCachedAntigravityAccountsState({
      accounts: [
        {
          id: 'acc-work',
          email: 'dev@company.com',
          subject: 'sub-1',
          authMethod: 'oauth',
          alias: 'Trabajo',
          color: '#3b82f6',
          emoji: '💼',
          createdAt: 1000,
          updatedAt: 1000
        }
      ],
      activeAccountId: 'acc-work',
      currentAccount: null,
      selectedAccountId: 'acc-work'
    })

    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment p={antigravityLimits()} compact={false} display="used" mode="verbose" />
    )

    expect(markup).toContain('data-antigravity-status-account')
    expect(markup).toContain('💼')
    expect(markup).toContain('Trabajo')
  })

  it('falls back to email prefix when emoji is present without alias', async () => {
    setCachedAntigravityAccountsState({
      accounts: [
        {
          id: 'acc-personal',
          email: 'geko@gmail.com',
          subject: 'sub-2',
          authMethod: 'oauth',
          alias: null,
          color: '#10b981',
          emoji: '⚡',
          createdAt: 1000,
          updatedAt: 1000
        }
      ],
      activeAccountId: 'acc-personal',
      currentAccount: null,
      selectedAccountId: 'acc-personal'
    })

    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment p={antigravityLimits()} compact={false} display="used" mode="verbose" />
    )

    expect(markup).toContain('⚡')
    expect(markup).toContain('geko')
  })

  it('switches active account when active tab has launchAccountId', async () => {
    setCachedAntigravityAccountsState({
      accounts: [
        {
          id: 'acc-work',
          email: 'work@co.com',
          subject: 'sub-1',
          authMethod: 'oauth',
          alias: 'Trabajo',
          color: '#3b82f6',
          emoji: '💼',
          createdAt: 1000,
          updatedAt: 1000
        },
        {
          id: 'acc-personal',
          email: 'personal@gmail.com',
          subject: 'sub-2',
          authMethod: 'oauth',
          alias: 'Personal',
          color: '#10b981',
          emoji: '🚀',
          createdAt: 1000,
          updatedAt: 1000
        }
      ],
      activeAccountId: 'acc-work',
      currentAccount: null,
      selectedAccountId: 'acc-work'
    })

    mockStoreState = {
      ...mockStoreState,
      activeTabId: 'tab-pers',
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-pers', launchAgent: 'antigravity', launchAccountId: 'acc-personal' }]
      }
    }

    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment p={antigravityLimits()} compact={false} display="used" mode="verbose" />
    )

    expect(markup).toContain('🚀')
    expect(markup).toContain('Personal')
    expect(markup).not.toContain('Trabajo')

    // Reset store state
    mockStoreState = {
      ...mockStoreState,
      activeTabId: null,
      tabsByWorktree: {}
    }
  })

  it('constrains max width in compact mode', async () => {
    setCachedAntigravityAccountsState({
      accounts: [
        {
          id: 'acc-work',
          email: 'work@co.com',
          subject: 'sub-1',
          authMethod: 'oauth',
          alias: 'VeryLongAccountAliasThatShouldBeConstrained',
          color: '#3b82f6',
          emoji: '💼',
          createdAt: 1000,
          updatedAt: 1000
        }
      ],
      activeAccountId: 'acc-work',
      currentAccount: null,
      selectedAccountId: 'acc-work'
    })

    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment p={antigravityLimits()} compact={true} display="used" mode="compact" />
    )

    expect(markup).toContain('max-w-[70px]')
    expect(markup).toContain('truncate')
  })

  it('preserves lastUsage and lastUsageAt in setCachedAntigravityAccountsState when incoming state has null or older values', () => {
    const existingUsage: ProviderRateLimits = antigravityLimits()
    setCachedAntigravityAccountsState({
      accounts: [
        {
          id: 'acc-1',
          email: 'user1@example.com',
          subject: 'sub-1',
          authMethod: 'oauth',
          createdAt: 1000,
          updatedAt: 1000,
          lastUsage: existingUsage,
          lastUsageAt: 5000
        }
      ],
      activeAccountId: 'acc-1',
      currentAccount: null,
      selectedAccountId: 'acc-1'
    })

    // Incoming state has null lastUsage and null lastUsageAt
    setCachedAntigravityAccountsState({
      accounts: [
        {
          id: 'acc-1',
          email: 'user1@example.com',
          subject: 'sub-1',
          authMethod: 'oauth',
          createdAt: 1000,
          updatedAt: 2000,
          lastUsage: null,
          lastUsageAt: null
        }
      ],
      activeAccountId: 'acc-1',
      currentAccount: null,
      selectedAccountId: 'acc-1'
    })

    expect(getCachedAntigravityAccountsState()?.accounts[0].lastUsage).toEqual(existingUsage)
    expect(getCachedAntigravityAccountsState()?.accounts[0].lastUsageAt).toBe(5000)

    // Incoming state has older lastUsageAt
    const olderUsage: ProviderRateLimits = { ...antigravityLimits(), updatedAt: 2000 }
    setCachedAntigravityAccountsState({
      accounts: [
        {
          id: 'acc-1',
          email: 'user1@example.com',
          subject: 'sub-1',
          authMethod: 'oauth',
          createdAt: 1000,
          updatedAt: 3000,
          lastUsage: olderUsage,
          lastUsageAt: 4000
        }
      ],
      activeAccountId: 'acc-1',
      currentAccount: null,
      selectedAccountId: 'acc-1'
    })

    expect(getCachedAntigravityAccountsState()?.accounts[0].lastUsage).toEqual(existingUsage)
    expect(getCachedAntigravityAccountsState()?.accounts[0].lastUsageAt).toBe(5000)

    // Incoming state has newer lastUsageAt
    const newerUsage: ProviderRateLimits = { ...antigravityLimits(), updatedAt: 6000 }
    setCachedAntigravityAccountsState({
      accounts: [
        {
          id: 'acc-1',
          email: 'user1@example.com',
          subject: 'sub-1',
          authMethod: 'oauth',
          createdAt: 1000,
          updatedAt: 4000,
          lastUsage: newerUsage,
          lastUsageAt: 6000
        }
      ],
      activeAccountId: 'acc-1',
      currentAccount: null,
      selectedAccountId: 'acc-1'
    })

    expect(getCachedAntigravityAccountsState()?.accounts[0].lastUsage).toEqual(newerUsage)
    expect(getCachedAntigravityAccountsState()?.accounts[0].lastUsageAt).toBe(6000)
  })

  it('updates cached account usage and notifies listeners via updateCachedAccountUsage', () => {
    setCachedAntigravityAccountsState({
      accounts: [
        {
          id: 'acc-1',
          email: 'user1@example.com',
          subject: 'sub-1',
          authMethod: 'oauth',
          createdAt: 1000,
          updatedAt: 1000
        }
      ],
      activeAccountId: 'acc-1',
      currentAccount: null,
      selectedAccountId: 'acc-1'
    })

    const listener = vi.fn()
    const unsubscribe = subscribeAntigravityAccountsState(listener)

    const newUsage = antigravityLimits()
    const beforeTime = Date.now()
    updateCachedAccountUsage('acc-1', newUsage)
    const afterTime = Date.now()

    expect(listener).toHaveBeenCalledTimes(1)
    const notifiedState = listener.mock.calls[0][0]
    expect(notifiedState?.accounts[0].lastUsage).toEqual(newUsage)
    expect(notifiedState?.accounts[0].lastUsageAt).toBeGreaterThanOrEqual(beforeTime)
    expect(notifiedState?.accounts[0].lastUsageAt).toBeLessThanOrEqual(afterTime)

    expect(getCachedAntigravityAccountsState()?.accounts[0].lastUsage).toEqual(newUsage)
    expect(getCachedAntigravityAccountsState()?.accounts[0].lastUsageAt).toBe(
      notifiedState?.accounts[0].lastUsageAt
    )

    unsubscribe()
  })

  it('renders tab account lastUsage and NOT p when active tab launchAccountId differs from activeAccountId', async () => {
    const workUsage = antigravityLimits({
      buckets: [{ name: 'Gemini Models', ...weeklyWindow(80) }]
    })
    const personalUsage = antigravityLimits({
      buckets: [{ name: 'Gemini Models', ...weeklyWindow(15) }]
    })

    setCachedAntigravityAccountsState({
      accounts: [
        {
          id: 'acc-work',
          email: 'work@co.com',
          subject: 'sub-1',
          authMethod: 'oauth',
          alias: 'Trabajo',
          color: '#3b82f6',
          emoji: '💼',
          createdAt: 1000,
          updatedAt: 1000,
          lastUsage: workUsage,
          lastUsageAt: 1000
        },
        {
          id: 'acc-personal',
          email: 'personal@gmail.com',
          subject: 'sub-2',
          authMethod: 'oauth',
          alias: 'Personal',
          color: '#10b981',
          emoji: '🚀',
          createdAt: 1000,
          updatedAt: 1000,
          lastUsage: personalUsage,
          lastUsageAt: 1000
        }
      ],
      activeAccountId: 'acc-work',
      currentAccount: null,
      selectedAccountId: 'acc-work'
    })

    mockStoreState = {
      ...mockStoreState,
      activeTabId: 'tab-pers',
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-pers', launchAgent: 'antigravity', launchAccountId: 'acc-personal' }]
      }
    }

    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment p={workUsage} compact={false} display="used" mode="verbose" />
    )

    expect(markup).toContain('Personal')
    expect(markup).toContain('15%')
    expect(markup).not.toContain('80%')

    mockStoreState = {
      ...mockStoreState,
      activeTabId: null,
      tabsByWorktree: {}
    }
  })

  it('falls back to activeAccount lastUsage when p authProvenance differs from active account', async () => {
    const activeUsage = antigravityLimits({
      buckets: [{ name: 'Gemini Models', ...weeklyWindow(25) }]
    })
    const mismatchedUsage = antigravityLimits({
      buckets: [{ name: 'Gemini Models', ...weeklyWindow(95) }],
      usageMetadata: { authProvenance: 'acc-other' }
    })

    setCachedAntigravityAccountsState({
      accounts: [
        {
          id: 'acc-work',
          email: 'work@co.com',
          subject: 'sub-1',
          authMethod: 'oauth',
          alias: 'Trabajo',
          color: '#3b82f6',
          emoji: '💼',
          createdAt: 1000,
          updatedAt: 1000,
          lastUsage: activeUsage,
          lastUsageAt: 1000
        }
      ],
      activeAccountId: 'acc-work',
      currentAccount: null,
      selectedAccountId: 'acc-work'
    })

    mockStoreState = {
      ...mockStoreState,
      activeTabId: null,
      tabsByWorktree: {}
    }

    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment p={mismatchedUsage} compact={false} display="used" mode="verbose" />
    )

    expect(markup).toContain('Trabajo')
    expect(markup).toContain('25%')
    expect(markup).not.toContain('95%')
  })

  it('renders loading placeholder when p authProvenance differs and active account has no lastUsage', async () => {
    const mismatchedUsage = antigravityLimits({
      buckets: [{ name: 'Gemini Models', ...weeklyWindow(95) }],
      usageMetadata: { authProvenance: 'acc-other' }
    })

    setCachedAntigravityAccountsState(null)
    setCachedAntigravityAccountsState({
      accounts: [
        {
          id: 'acc-work',
          email: 'work@co.com',
          subject: 'sub-1',
          authMethod: 'oauth',
          alias: 'Trabajo',
          color: '#3b82f6',
          emoji: '💼',
          createdAt: 1000,
          updatedAt: 1000,
          lastUsage: null,
          lastUsageAt: null
        }
      ],
      activeAccountId: 'acc-work',
      currentAccount: null,
      selectedAccountId: 'acc-work'
    })

    mockStoreState = {
      ...mockStoreState,
      activeTabId: null,
      tabsByWorktree: {}
    }

    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment p={mismatchedUsage} compact={false} display="used" mode="verbose" />
    )

    expect(markup).toContain('···')
    expect(markup).not.toContain('95%')
  })

  it('preserves fetching status when falling back to activeAccount lastUsage with mismatched authProvenance', async () => {
    const activeUsage = antigravityLimits({
      status: 'ok',
      buckets: [{ name: 'Gemini Models', ...weeklyWindow(25) }]
    })
    const fetchingMismatchedUsage = antigravityLimits({
      status: 'fetching',
      buckets: [{ name: 'Gemini Models', ...weeklyWindow(95) }],
      usageMetadata: { authProvenance: 'acc-other' }
    })

    setCachedAntigravityAccountsState(null)
    setCachedAntigravityAccountsState({
      accounts: [
        {
          id: 'acc-work',
          email: 'work@co.com',
          subject: 'sub-1',
          authMethod: 'oauth',
          alias: 'Trabajo',
          color: '#3b82f6',
          emoji: '💼',
          createdAt: 1000,
          updatedAt: 1000,
          lastUsage: activeUsage,
          lastUsageAt: 1000
        }
      ],
      activeAccountId: 'acc-work',
      currentAccount: null,
      selectedAccountId: 'acc-work'
    })

    mockStoreState = {
      ...mockStoreState,
      activeTabId: null,
      tabsByWorktree: {}
    }

    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment p={fetchingMismatchedUsage} compact={false} display="used" mode="verbose" />
    )

    expect(markup).toContain('Trabajo')
    expect(markup).toContain('25%')
    expect(markup).not.toContain('95%')
  })
})
