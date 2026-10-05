// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { setCachedAntigravityAccountsState } from '@/hooks/useAntigravityAccounts'
import { AntigravitySwitcherMenu } from './AntigravitySwitcherMenu'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => null
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: any) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: any) => <>{children}</>,
  DropdownMenuContent: ({ children }: any) => <div role="menu">{children}</div>,
  DropdownMenuItem: ({ children, onSelect, disabled }: any) => (
    <button type="button" role="menuitem" onClick={(e) => onSelect?.(e)} disabled={disabled}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: any) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuSub: ({ children }: any) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children }: any) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: any) => <div>{children}</div>
}))

const mockOpenSettingsPage = vi.fn()
const mockOpenSettingsTarget = vi.fn()
const mockRefreshRateLimits = vi.fn()

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: any) => unknown) =>
    selector({
      openSettingsPage: mockOpenSettingsPage,
      openSettingsTarget: mockOpenSettingsTarget,
      refreshRateLimits: mockRefreshRateLimits,
      usagePercentageDisplay: 'used'
    })
}))

const mockCallAntigravityAccounts = vi.fn()
vi.mock('@/runtime/runtime-antigravity-accounts-client', () => ({
  callAntigravityAccounts: (...args: unknown[]) => mockCallAntigravityAccounts(...args)
}))

function createRateLimits(usedPercent = 25): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: { windowMinutes: 300, usedPercent, resetsAt: Date.now() + 10000 },
    weekly: { windowMinutes: 10080, usedPercent: 40, resetsAt: Date.now() + 50000 },
    updatedAt: Date.now(),
    error: null,
    status: 'ok'
  }
}

describe('AntigravitySwitcherMenu', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    setCachedAntigravityAccountsState({
      accounts: [
        {
          id: 'acc-1',
          email: 'personal@gmail.com',
          subject: 'sub-1',
          authMethod: 'oauth',
          alias: 'Personal',
          color: '#3b82f6',
          emoji: '🏠',
          createdAt: 1000,
          updatedAt: 1000,
          lastUsage: createRateLimits(20)
        },
        {
          id: 'acc-2',
          email: 'work@company.com',
          subject: 'sub-2',
          authMethod: 'oauth',
          alias: 'Trabajo',
          color: '#10b981',
          emoji: '💼',
          createdAt: 2000,
          updatedAt: 2000,
          lastUsage: null
        }
      ],
      activeAccountId: 'acc-1',
      selectedAccountId: 'acc-1',
      currentAccount: {
        email: 'personal@gmail.com',
        subject: 'sub-1',
        authMethod: 'oauth',
        identityKnown: true
      }
    })
  })

  it('renders the active account with its alias and emoji', () => {
    render(
      <AntigravitySwitcherMenu
        antigravity={createRateLimits()}
        compact={false}
        iconOnly={false}
      />
    )

    expect(screen.getAllByText('Personal').length).toBeGreaterThan(0)
    expect(screen.getAllByText('🏠').length).toBeGreaterThan(0)
  })

  it('expands accounts list and displays other accounts with usage or empty fallback', () => {
    render(
      <AntigravitySwitcherMenu
        antigravity={createRateLimits()}
        compact={false}
        iconOnly={false}
      />
    )

    // Click to expand accounts (the dropdown item)
    const trigger = screen.getAllByText('Personal')[1]
    fireEvent.click(trigger)

    expect(screen.getByText('Switch to')).toBeDefined()
    expect(screen.getByText('Trabajo')).toBeDefined()
    expect(screen.getByText('💼')).toBeDefined()
    expect(screen.getByText('No usage data yet')).toBeDefined()
  })

  it('calls callAntigravityAccounts when clicking an inactive account row', async () => {
    mockCallAntigravityAccounts.mockResolvedValueOnce({
      accounts: [],
      activeAccountId: 'acc-2',
      selectedAccountId: 'acc-2',
      currentAccount: null
    })

    render(
      <AntigravitySwitcherMenu
        antigravity={createRateLimits()}
        compact={false}
        iconOnly={false}
      />
    )

    const trigger = screen.getAllByText('Personal')[1]
    fireEvent.click(trigger)

    const workRow = screen.getByText('Trabajo')
    fireEvent.click(workRow)

    expect(mockCallAntigravityAccounts).toHaveBeenCalledWith(
      { kind: 'local' },
      { runtime: 'host' },
      'Select',
      'acc-2'
    )
  })

  it('navigates to Settings when clicking Manage Accounts', () => {
    render(
      <AntigravitySwitcherMenu
        antigravity={createRateLimits()}
        compact={false}
        iconOnly={false}
      />
    )

    const manageBtn = screen.getByText('Manage Accounts…')
    fireEvent.click(manageBtn)

    expect(mockOpenSettingsTarget).toHaveBeenCalledWith({
      pane: 'accounts',
      repoId: null,
      sectionId: 'accounts-antigravity'
    })
    expect(mockOpenSettingsPage).toHaveBeenCalled()
  })
})
