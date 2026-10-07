// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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

type ComponentMockProps = {
  children?: React.ReactNode
}

type MenuItemMockProps = {
  children?: React.ReactNode
  onSelect?: (event: unknown) => void
  disabled?: boolean
}

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: ComponentMockProps) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: ComponentMockProps) => <>{children}</>,
  DropdownMenuContent: ({ children }: ComponentMockProps) => <div role="menu">{children}</div>,
  DropdownMenuItem: ({ children, onSelect, disabled }: MenuItemMockProps) => (
    <button type="button" role="menuitem" onClick={(e) => onSelect?.(e)} disabled={disabled}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: ComponentMockProps) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuSub: ({ children }: ComponentMockProps) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children }: ComponentMockProps) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: ComponentMockProps) => <div>{children}</div>
}))

const mockOpenSettingsPage = vi.fn()
const mockOpenSettingsTarget = vi.fn()
const mockRefreshRateLimits = vi.fn()
const mockSetAntigravityRateLimitsOptimistic = vi.fn()
const mockCloseTab = vi.fn()
const mockLaunchAgentInNewTab = vi.fn()

vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: (...args: unknown[]) => mockLaunchAgentInNewTab(...args)
}))

type MockStoreRepo = {
  id: string
  antigravityAccountId?: string | null
}

type MockAppStoreState = {
  openSettingsPage: () => void
  openSettingsTarget: (target: unknown) => void
  refreshRateLimits: () => void
  setAntigravityRateLimitsOptimistic: (targetUsage?: ProviderRateLimits | null) => void
  closeTab: (tabId: string) => void
  usagePercentageDisplay: 'used'
  activeRepoId: string | null
  activeWorktreeId: string | null
  activeTabIdByWorktree: Record<string, string | null>
  activeTabId: string | null
  repos: MockStoreRepo[]
  tabsByWorktree: Record<string, unknown[]>
  unifiedTabsByWorktree: Record<string, unknown[]>
}

const mockStoreState: MockAppStoreState = {
  openSettingsPage: mockOpenSettingsPage,
  openSettingsTarget: mockOpenSettingsTarget,
  refreshRateLimits: mockRefreshRateLimits,
  setAntigravityRateLimitsOptimistic: mockSetAntigravityRateLimitsOptimistic,
  closeTab: mockCloseTab,
  usagePercentageDisplay: 'used',
  activeRepoId: null,
  activeWorktreeId: null,
  activeTabIdByWorktree: {},
  activeTabId: null,
  repos: [],
  tabsByWorktree: {},
  unifiedTabsByWorktree: {}
}

vi.mock('../../store', () => {
  const storeFn = Object.assign(
    (selector: (state: MockAppStoreState) => unknown) => selector(mockStoreState),
    { getState: () => mockStoreState }
  )
  return { useAppStore: storeFn }
})

const mockCallAntigravityAccounts = vi.fn().mockResolvedValue({
  accounts: [],
  activeAccountId: null,
  selectedAccountId: null,
  currentAccount: null
})
vi.mock('@/runtime/runtime-antigravity-accounts-client', () => ({
  callAntigravityAccounts: (...args: unknown[]) => mockCallAntigravityAccounts(...args)
}))

function createRateLimits(usedPercent = 25): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: {
      windowMinutes: 300,
      usedPercent,
      resetsAt: Date.now() + 10000,
      resetDescription: null
    },
    weekly: {
      windowMinutes: 10080,
      usedPercent: 40,
      resetsAt: Date.now() + 50000,
      resetDescription: null
    },
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
    mockCallAntigravityAccounts.mockReset()
    mockCallAntigravityAccounts.mockResolvedValue({
      accounts: [],
      activeAccountId: null,
      selectedAccountId: null,
      currentAccount: null
    })
    mockCloseTab.mockReset()
    mockLaunchAgentInNewTab.mockReset()
    mockStoreState.activeRepoId = null
    mockStoreState.activeWorktreeId = null
    mockStoreState.repos = []
    mockStoreState.tabsByWorktree = {}
    mockStoreState.unifiedTabsByWorktree = {}
    mockStoreState.activeTabIdByWorktree = {}
    mockStoreState.activeTabId = null
    setCachedAntigravityAccountsState(null)
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
      <AntigravitySwitcherMenu antigravity={createRateLimits()} compact={false} iconOnly={false} />
    )

    expect(screen.getAllByText('Personal').length).toBeGreaterThan(0)
    expect(screen.getAllByText('🏠').length).toBeGreaterThan(0)
  })

  it('renders popover header with account alias "Antigravity (Personal)"', () => {
    render(
      <AntigravitySwitcherMenu antigravity={createRateLimits()} compact={false} iconOnly={false} />
    )

    expect(screen.getByText('Antigravity (Personal)')).toBeDefined()
  })

  it('falls back to "Antigravity" header when no account alias or email prefix exists', () => {
    setCachedAntigravityAccountsState(null)

    render(
      <AntigravitySwitcherMenu antigravity={createRateLimits()} compact={false} iconOnly={false} />
    )

    expect(screen.getByText('Antigravity')).toBeDefined()
    expect(screen.queryByText('Antigravity (Personal)')).toBeNull()
  })

  it('expands accounts list and displays other accounts with usage or empty fallback', () => {
    render(
      <AntigravitySwitcherMenu antigravity={createRateLimits()} compact={false} iconOnly={false} />
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
      <AntigravitySwitcherMenu antigravity={createRateLimits()} compact={false} iconOnly={false} />
    )

    const trigger = screen.getAllByText('Personal')[1]
    fireEvent.click(trigger)

    const workRow = screen.getByText('Trabajo')
    fireEvent.click(workRow)

    const confirmBtn = screen.getByRole('button', { name: 'Switch account' })
    await act(async () => {
      fireEvent.click(confirmBtn)
    })

    expect(mockCallAntigravityAccounts).toHaveBeenCalledWith(
      { kind: 'local' },
      { runtime: 'host' },
      'Select',
      'acc-2'
    )
  })

  it('navigates to Settings when clicking Manage Accounts', () => {
    render(
      <AntigravitySwitcherMenu antigravity={createRateLimits()} compact={false} iconOnly={false} />
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

  it('renders restart notice when accounts list is expanded', () => {
    render(
      <AntigravitySwitcherMenu antigravity={createRateLimits()} compact={false} iconOnly={false} />
    )

    const trigger = screen.getAllByText('Personal')[1]
    fireEvent.click(trigger)

    expect(
      screen.getByText(
        'Restart live Antigravity terminals before continuing old conversations after switching.'
      )
    ).toBeTruthy()
  })

  it('displays project default alignment banner when active repo default differs from active account', () => {
    mockStoreState.activeRepoId = 'repo-1'
    mockStoreState.repos = [{ id: 'repo-1', antigravityAccountId: 'acc-2' }]

    render(
      <AntigravitySwitcherMenu antigravity={createRateLimits()} compact={false} iconOnly={false} />
    )

    expect(screen.getByText('Project Default')).toBeDefined()
    expect(screen.getByText('Trabajo')).toBeDefined()
  })

  it('switches account when clicking switch to project default button', async () => {
    mockCallAntigravityAccounts.mockResolvedValueOnce({
      accounts: [],
      activeAccountId: 'acc-2',
      selectedAccountId: 'acc-2',
      currentAccount: null
    })
    mockStoreState.activeRepoId = 'repo-1'
    mockStoreState.repos = [{ id: 'repo-1', antigravityAccountId: 'acc-2' }]

    render(
      <AntigravitySwitcherMenu antigravity={createRateLimits()} compact={false} iconOnly={false} />
    )

    const switchBtn = screen.getByRole('button', { name: 'Switch' })
    fireEvent.click(switchBtn)

    const confirmBtn = screen.getByRole('button', { name: 'Switch account' })
    await act(async () => {
      fireEvent.click(confirmBtn)
    })

    expect(mockCallAntigravityAccounts).toHaveBeenCalledWith(
      { kind: 'local' },
      { runtime: 'host' },
      'Select',
      'acc-2'
    )
  })

  it('does not display project default banner when active account matches project default', () => {
    mockStoreState.activeRepoId = 'repo-1'
    mockStoreState.repos = [{ id: 'repo-1', antigravityAccountId: 'acc-1' }]

    render(
      <AntigravitySwitcherMenu antigravity={createRateLimits()} compact={false} iconOnly={false} />
    )

    expect(screen.queryByText('Project Default')).toBeNull()
  })

  it('retains Account 1 usage and displays Account 2 lastUsage with updating state when switching to Account 2', async () => {
    const acc1Usage = {
      ...createRateLimits(20),
      usageMetadata: { authProvenance: 'acc-1' }
    }
    const acc2Usage = {
      ...createRateLimits(80),
      usageMetadata: { authProvenance: 'acc-2' }
    }

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
          lastUsage: acc1Usage
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
          lastUsage: acc2Usage
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

    mockCallAntigravityAccounts.mockResolvedValueOnce({
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
          lastUsage: acc1Usage
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
          lastUsage: acc2Usage
        }
      ],
      activeAccountId: 'acc-2',
      selectedAccountId: 'acc-2',
      currentAccount: {
        email: 'work@company.com',
        subject: 'sub-2',
        authMethod: 'oauth',
        identityKnown: true
      }
    })

    const { rerender } = render(
      <AntigravitySwitcherMenu antigravity={acc1Usage} compact={false} iconOnly={false} />
    )

    const trigger = screen.getAllByText('Personal')[1]
    fireEvent.click(trigger)

    expect(screen.getAllByText('20%').length).toBeGreaterThan(0)
    expect(screen.getByText('80%')).toBeDefined()

    const workRow = screen.getByText('Trabajo')
    fireEvent.click(workRow)
    const confirmBtn = screen.getByRole('button', { name: 'Switch account' })
    await act(async () => {
      fireEvent.click(confirmBtn)
    })

    expect(mockCallAntigravityAccounts).toHaveBeenCalledWith(
      { kind: 'local' },
      { runtime: 'host' },
      'Select',
      'acc-2'
    )

    expect(screen.getAllByText('80%').length).toBeGreaterThan(0)
    expect(screen.getAllByText('20%').length).toBeGreaterThan(0)

    rerender(
      <AntigravitySwitcherMenu
        antigravity={{ ...acc2Usage, status: 'fetching' }}
        compact={false}
        iconOnly={false}
      />
    )

    expect(screen.getAllByText('80%').length).toBeGreaterThan(0)
    expect(screen.getAllByText('20%').length).toBeGreaterThan(0)
    const pulsingElements = screen
      .getAllByText('80%')
      .map((el) => el.closest('.animate-pulse'))
      .filter(Boolean)
    expect(pulsingElements.length).toBeGreaterThan(0)
  })

  it('displays "No usage data yet" when switching to an account without prior usage without inheriting outgoing quota', async () => {
    const acc1Usage = {
      ...createRateLimits(20),
      usageMetadata: { authProvenance: 'acc-1' }
    }

    mockCallAntigravityAccounts.mockResolvedValueOnce({
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
          lastUsage: acc1Usage
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
      activeAccountId: 'acc-2',
      selectedAccountId: 'acc-2',
      currentAccount: {
        email: 'work@company.com',
        subject: 'sub-2',
        authMethod: 'oauth',
        identityKnown: true
      }
    })

    render(<AntigravitySwitcherMenu antigravity={acc1Usage} compact={false} iconOnly={false} />)

    const trigger = screen.getAllByText('Personal')[1]
    fireEvent.click(trigger)

    expect(screen.getByText('No usage data yet')).toBeDefined()

    const workRow = screen.getByText('Trabajo')
    fireEvent.click(workRow)
    const confirmBtn = screen.getByRole('button', { name: 'Switch account' })
    await act(async () => {
      fireEvent.click(confirmBtn)
    })

    expect(screen.getByText('No usage data yet')).toBeDefined()
  })

  it('disables switching actions and ignores rapid clicks while switching', async () => {
    let resolveCall!: (value: unknown) => void
    mockCallAntigravityAccounts.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCall = resolve
        })
    )

    render(
      <AntigravitySwitcherMenu
        antigravity={createRateLimits(20)}
        compact={false}
        iconOnly={false}
      />
    )

    const trigger = screen.getAllByText('Personal')[1]
    fireEvent.click(trigger)

    const workRow = screen.getByText('Trabajo')
    const workButton = workRow.closest('button')
    expect(workButton).not.toBeNull()

    fireEvent.click(workRow)
    const confirmBtn = screen.getByRole('button', { name: 'Switch account' })
    await act(async () => {
      fireEvent.click(confirmBtn)
    })
    expect(mockCallAntigravityAccounts).toHaveBeenCalledTimes(1)

    expect(workButton).toBeDisabled()

    fireEvent.click(workRow)
    expect(mockCallAntigravityAccounts).toHaveBeenCalledTimes(1)

    resolveCall({
      accounts: [],
      activeAccountId: 'acc-2',
      selectedAccountId: 'acc-2',
      currentAccount: null
    })
  })

  it('cancels account switch and does not call callAntigravityAccounts when clicking Cancel', async () => {
    render(
      <AntigravitySwitcherMenu antigravity={createRateLimits()} compact={false} iconOnly={false} />
    )

    const trigger = screen.getAllByText('Personal')[1]
    fireEvent.click(trigger)

    const workRow = screen.getByText('Trabajo')
    fireEvent.click(workRow)

    expect(screen.getByText('Switch Antigravity account?')).toBeDefined()
    const cancelBtn = screen.getByRole('button', { name: 'Cancel' })
    fireEvent.click(cancelBtn)

    expect(mockCallAntigravityAccounts).not.toHaveBeenCalled()
  })

  it('detects active Antigravity session, displays warning in dialog, and restarts session on switch', async () => {
    mockCallAntigravityAccounts.mockResolvedValueOnce({
      accounts: [],
      activeAccountId: 'acc-2',
      selectedAccountId: 'acc-2',
      currentAccount: null
    })
    mockStoreState.activeWorktreeId = 'wt-1'
    mockStoreState.tabsByWorktree = {
      'wt-1': [
        {
          id: 'tab-agy-1',
          worktreeId: 'wt-1',
          launchAgent: 'antigravity',
          launchAccountId: 'acc-1',
          title: 'Antigravity',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: Date.now(),
          ptyId: 'pty-1',
          startupCwd: '/repo'
        }
      ]
    }
    mockStoreState.unifiedTabsByWorktree = {
      'wt-1': [
        {
          id: 'u-1',
          entityId: 'tab-agy-1',
          contentType: 'terminal',
          worktreeId: 'wt-1',
          groupId: 'grp-1'
        }
      ]
    }

    render(
      <AntigravitySwitcherMenu antigravity={createRateLimits()} compact={false} iconOnly={false} />
    )

    const trigger = screen.getAllByText('Personal')[1]
    fireEvent.click(trigger)

    const workRow = screen.getByText('Trabajo')
    fireEvent.click(workRow)

    expect(screen.getByText(/close your active Antigravity session/)).toBeDefined()
    const restartBtn = screen.getByRole('button', { name: 'Switch & restart session' })
    await act(async () => {
      fireEvent.click(restartBtn)
    })

    expect(mockCallAntigravityAccounts).toHaveBeenCalledWith(
      { kind: 'local' },
      { runtime: 'host' },
      'Select',
      'acc-2'
    )
    expect(mockCloseTab).toHaveBeenCalledWith('tab-agy-1')
    expect(mockLaunchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'antigravity',
        worktreeId: 'wt-1',
        launchAccountId: 'acc-2',
        groupId: 'grp-1',
        initialCwd: '/repo'
      })
    )
  })
})
