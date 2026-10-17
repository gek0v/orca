import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import { setCachedAntigravityAccountsState } from '@/hooks/useAntigravityAccounts'
import { ProviderSegment } from './StatusBarProviderSegment'

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
  activePaneId?: string | number | null
  unifiedTabsByWorktree: Record<
    string,
    {
      id: string
      entityId?: string
      launchAgent?: string
      launchAccountId?: string
      contentType?: string
    }[]
  >
  tabsByWorktree: Record<string, { id: string; launchAgent?: string; launchAccountId?: string }[]>
}

let mockStoreState: MockStoreState = {
  usagePercentageDisplay: 'used',
  activeTabId: null,
  activePaneId: null,
  unifiedTabsByWorktree: {},
  tabsByWorktree: {}
}

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: MockStoreState) => unknown) => selector(mockStoreState)
}))

const WEEKLY_MINUTES = 10_080

function weeklyWindow(usedPercent: number): RateLimitWindow {
  return { usedPercent, windowMinutes: WEEKLY_MINUTES, resetsAt: null, resetDescription: null }
}

function makeAntigravityLimits(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: weeklyWindow(50),
    buckets: [{ name: 'Gemini Models', ...weeklyWindow(50) }],
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    ...overrides
  }
}

describe('StatusBarProviderSegment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setCachedAntigravityAccountsState(null)
    mockStoreState = {
      usagePercentageDisplay: 'used',
      activeTabId: null,
      activePaneId: null,
      unifiedTabsByWorktree: {},
      tabsByWorktree: {}
    }
  })

  it('picks displayedAccount.lastUsage whenever displayedAccount exists', () => {
    const globalUsage = makeAntigravityLimits({
      buckets: [{ name: 'Gemini Models', ...weeklyWindow(80) }]
    })
    const accountUsage = makeAntigravityLimits({
      buckets: [{ name: 'Gemini Models', ...weeklyWindow(20) }]
    })

    setCachedAntigravityAccountsState({
      accounts: [
        {
          id: 'acc-1',
          email: 'acc1@example.com',
          subject: 'sub-1',
          authMethod: 'oauth',
          alias: 'Personal',
          emoji: '🌟',
          color: null,
          createdAt: 1000,
          updatedAt: 1000,
          lastUsage: accountUsage,
          lastUsageAt: 1000
        }
      ],
      activeAccountId: 'acc-1',
      currentAccount: null,
      selectedAccountId: 'acc-1'
    })

    const markup = renderToStaticMarkup(
      <ProviderSegment p={globalUsage} compact={false} display="used" mode="verbose" />
    )

    // Should render the displayedAccount's fresh quota (20%), not stale globalUsage (80%)
    expect(markup).toContain('20%')
    expect(markup).not.toContain('80%')
    expect(markup).toContain('Personal')
  })

  it('renders focused split pane account quota reactively when activePaneId matches', () => {
    const tabAccountUsage = makeAntigravityLimits({
      buckets: [{ name: 'Gemini Models', ...weeklyWindow(60) }]
    })
    const paneAccountUsage = makeAntigravityLimits({
      buckets: [{ name: 'Gemini Models', ...weeklyWindow(15) }]
    })

    setCachedAntigravityAccountsState({
      accounts: [
        {
          id: 'acc-tab',
          email: 'tab@example.com',
          subject: 'sub-tab',
          authMethod: 'oauth',
          alias: 'TabAgent',
          emoji: '📁',
          color: null,
          createdAt: 1000,
          updatedAt: 1000,
          lastUsage: tabAccountUsage,
          lastUsageAt: 1000
        },
        {
          id: 'acc-pane',
          email: 'pane@example.com',
          subject: 'sub-pane',
          authMethod: 'oauth',
          alias: 'PaneAgent',
          emoji: '⚡',
          color: null,
          createdAt: 1000,
          updatedAt: 1000,
          lastUsage: paneAccountUsage,
          lastUsageAt: 1000
        }
      ],
      activeAccountId: 'acc-tab',
      currentAccount: null,
      selectedAccountId: 'acc-tab'
    })

    mockStoreState = {
      ...mockStoreState,
      activeTabId: 'tab-1',
      activePaneId: 'pane-split-leaf-2',
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'tab-1',
            launchAgent: 'antigravity',
            launchAccountId: 'acc-tab'
          },
          {
            id: 'pane-split-leaf-2',
            launchAgent: 'antigravity',
            launchAccountId: 'acc-pane'
          }
        ]
      }
    }

    const fallbackUsage = makeAntigravityLimits({
      buckets: [{ name: 'Gemini Models', ...weeklyWindow(90) }]
    })

    const markup = renderToStaticMarkup(
      <ProviderSegment p={fallbackUsage} compact={false} display="used" mode="verbose" />
    )

    // Should resolve focused split pane leaf acc-pane (15%) immediately
    expect(markup).toContain('15%')
    expect(markup).not.toContain('60%')
    expect(markup).not.toContain('90%')
    expect(markup).toContain('PaneAgent')
  })
})
