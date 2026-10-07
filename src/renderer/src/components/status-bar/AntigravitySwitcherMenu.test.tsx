// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

type MockStoreRepo = {
  id: string
  antigravityAccountId?: string | null
}

type MockAppStoreState = {
  openSettingsPage: () => void
  openSettingsTarget: (target: unknown) => void
  refreshRateLimits: () => void
  usagePercentageDisplay: 'used'
  activeRepoId: string | null
  activeWorktreeId: string | null
  repos: MockStoreRepo[]
}

const mockStoreState: MockAppStoreState = {
  openSettingsPage: mockOpenSettingsPage,
  openSettingsTarget: mockOpenSettingsTarget,
  refreshRateLimits: mockRefreshRateLimits,
  usagePercentageDisplay: 'used',
  activeRepoId: null,
  activeWorktreeId: null,
  repos: []
}

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: MockAppStoreState) => unknown) => selector(mockStoreState)
}))

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
    mockStoreState.activeRepoId = null
    mockStoreState.activeWorktreeId = null
    mockStoreState.repos = []
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
})
