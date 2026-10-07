// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { AntigravityAccountSummary } from '../../../../shared/antigravity-account-types'
import { RepositoryAntigravityAccountSection } from './RepositoryAntigravityAccountSection'

const { mockUseAntigravityAccounts, mockRefreshAntigravityAccounts } = vi.hoisted(() => ({
  mockUseAntigravityAccounts: vi.fn(),
  mockRefreshAntigravityAccounts: vi.fn()
}))

vi.mock('@/hooks/useAntigravityAccounts', () => ({
  useAntigravityAccounts: mockUseAntigravityAccounts,
  refreshAntigravityAccounts: mockRefreshAntigravityAccounts
}))

vi.mock('../ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children
  }: {
    value: string
    onValueChange: (value: string) => void
    disabled?: boolean
    children: React.ReactNode
  }) => (
    <select
      value={value}
      disabled={disabled}
      data-testid="antigravity-account-select"
      onChange={(event) => onValueChange(event.currentTarget.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({
    value,
    disabled,
    children
  }: {
    value: string
    disabled?: boolean
    children: React.ReactNode
  }) => (
    <option value={value} disabled={disabled}>
      {children}
    </option>
  )
}))

const BASE_REPO: Repo = {
  id: 'repo-1',
  path: '/workspaces/siren',
  displayName: 'Siren',
  badgeColor: '#000000',
  addedAt: 0
}

const ACCOUNT_WORK: AntigravityAccountSummary = {
  id: 'acc-work',
  email: 'work@corp.com',
  subject: 'sub-work',
  authMethod: 'google',
  alias: 'Work Account',
  color: '#3b82f6',
  emoji: '💼',
  createdAt: 1000,
  updatedAt: 1000
}

const ACCOUNT_PERSONAL: AntigravityAccountSummary = {
  id: 'acc-personal',
  email: 'personal@gmail.com',
  subject: 'sub-pers',
  authMethod: 'google',
  alias: 'Personal Account',
  color: '#10b981',
  emoji: '🚀',
  createdAt: 1000,
  updatedAt: 1000
}

describe('RepositoryAntigravityAccountSection', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mockRefreshAntigravityAccounts.mockResolvedValue({})
    mockUseAntigravityAccounts.mockReturnValue({
      accounts: [ACCOUNT_WORK, ACCOUNT_PERSONAL],
      activeAccount: ACCOUNT_WORK,
      state: { accounts: [ACCOUNT_WORK, ACCOUNT_PERSONAL], activeAccountId: 'acc-work' },
      getAccountById: (id: string) =>
        [ACCOUNT_WORK, ACCOUNT_PERSONAL].find((a) => a.id === id) ?? null
    })
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }
    container?.remove()
    container = null
    root = null
    vi.clearAllMocks()
  })

  async function render(
    repo: Repo = BASE_REPO,
    updateRepo: (
      repoId: string,
      updates: { antigravityAccountId?: string | null }
    ) => unknown = vi.fn()
  ) {
    await act(async () => {
      root?.render(
        <RepositoryAntigravityAccountSection
          repo={repo}
          updateRepo={updateRepo}
          forceVisible={true}
        />
      )
    })
  }

  function getSelect(): HTMLSelectElement {
    const select = container?.querySelector('select')
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error('select element not found')
    }
    return select
  }

  function getRefreshButton(): HTMLButtonElement {
    const button = container?.querySelector('button[aria-label="Refresh Antigravity accounts"]')
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('refresh button not found')
    }
    return button
  }

  it('renders section title and defaults to ambient when no binding exists', async () => {
    await render(BASE_REPO)
    expect(container?.textContent).toContain('Default Antigravity Account')
    expect(getSelect().value).toBe('__ambient_antigravity_account__')
  })

  it('lists all accounts with alias and email in the select options', async () => {
    await render(BASE_REPO)
    const options = Array.from(container?.querySelectorAll('option') ?? []).map(
      (o) => o.textContent
    )
    expect(options.some((text) => text?.includes('Work Account'))).toBe(true)
    expect(options.some((text) => text?.includes('Personal Account'))).toBe(true)
  })

  it('reflects existing binding when repo has antigravityAccountId', async () => {
    await render({ ...BASE_REPO, antigravityAccountId: 'acc-personal' })
    expect(getSelect().value).toBe('acc-personal')
  })

  it('calls updateRepo with selected accountId on selection change', async () => {
    const updateRepo = vi.fn()
    await render(BASE_REPO, updateRepo)

    const select = getSelect()
    await act(async () => {
      select.value = 'acc-personal'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(updateRepo).toHaveBeenCalledWith('repo-1', { antigravityAccountId: 'acc-personal' })
  })

  it('calls updateRepo with null when switching back to ambient', async () => {
    const updateRepo = vi.fn()
    await render({ ...BASE_REPO, antigravityAccountId: 'acc-work' }, updateRepo)

    const select = getSelect()
    await act(async () => {
      select.value = '__ambient_antigravity_account__'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(updateRepo).toHaveBeenCalledWith('repo-1', { antigravityAccountId: null })
  })

  it('renders warning when bound account is not found in account inventory', async () => {
    await render({ ...BASE_REPO, antigravityAccountId: 'acc-missing' })
    expect(container?.textContent).toContain('Bound account not found on this machine')
  })

  it('calls refreshAntigravityAccounts when clicking the refresh button', async () => {
    await render(BASE_REPO)
    const refreshBtn = getRefreshButton()

    await act(async () => {
      refreshBtn.click()
    })

    expect(mockRefreshAntigravityAccounts).toHaveBeenCalled()
  })
})
