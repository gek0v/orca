// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCachedAntigravityAccountsState } from '@/hooks/useAntigravityAccounts'
import { NativeChatAccountSelector } from './NativeChatAccountSelector'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import * as runtimeClient from '@/runtime/runtime-antigravity-accounts-client'

let container: HTMLDivElement
let root: Root

function renderWithProviders(ui: React.ReactElement) {
  return root.render(<TooltipProvider>{ui}</TooltipProvider>)
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useAppStore.setState({
    settingsNavigationTarget: null,
    activeView: 'terminal'
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const account1 = {
  id: 'acc-1',
  email: 'user1@gmail.com',
  subject: 'sub-1',
  authMethod: 'oauth',
  alias: 'Personal',
  color: '#3b82f6',
  createdAt: 0,
  updatedAt: 0
}

const account2 = {
  id: 'acc-2',
  email: 'work@company.com',
  subject: 'sub-2',
  authMethod: 'oauth',
  alias: 'Work',
  emoji: '💼',
  color: '#10b981',
  createdAt: 0,
  updatedAt: 0
}

describe('NativeChatAccountSelector', () => {
  it('returns null when agent is not antigravity', async () => {
    setCachedAntigravityAccountsState({
      accounts: [account1],
      activeAccountId: 'acc-1',
      selectedAccountId: null,
      currentAccount: null
    })

    await act(async () => {
      renderWithProviders(<NativeChatAccountSelector agent="claude" />)
    })

    expect(container.innerHTML).toBe('')
  })

  it('renders active account badge, alias, and tooltip when agent is antigravity', async () => {
    setCachedAntigravityAccountsState({
      accounts: [account1, account2],
      activeAccountId: 'acc-1',
      selectedAccountId: null,
      currentAccount: null
    })

    await act(async () => {
      renderWithProviders(<NativeChatAccountSelector agent="antigravity" />)
    })

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="native-chat-account-selector-trigger"]'
    )
    expect(trigger).not.toBeNull()
    expect(trigger?.textContent).toContain('Personal')
    expect(trigger?.getAttribute('aria-label')).toBe('user1@gmail.com (Personal)')

    const colorDot = trigger?.querySelector('[data-account-color="#3b82f6"]')
    expect(colorDot).not.toBeNull()
  })

  it('renders active account emoji when present', async () => {
    setCachedAntigravityAccountsState({
      accounts: [account1, account2],
      activeAccountId: 'acc-2',
      selectedAccountId: null,
      currentAccount: null
    })

    await act(async () => {
      renderWithProviders(<NativeChatAccountSelector agent="antigravity" />)
    })

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="native-chat-account-selector-trigger"]'
    )
    expect(trigger).not.toBeNull()
    expect(trigger?.textContent).toContain('Work')
    expect(trigger?.getAttribute('aria-label')).toBe('work@company.com (Work)')

    const emojiSpan = trigger?.querySelector('[data-account-emoji="💼"]')
    expect(emojiSpan).not.toBeNull()
    expect(emojiSpan?.textContent).toBe('💼')
  })

  it('renders accounts list with checkmark for active account when open', async () => {
    setCachedAntigravityAccountsState({
      accounts: [account1, account2],
      activeAccountId: 'acc-1',
      selectedAccountId: null,
      currentAccount: null
    })

    await act(async () => {
      renderWithProviders(<NativeChatAccountSelector agent="antigravity" open={true} />)
    })

    const item1 = document.querySelector('[data-testid="native-chat-account-item-acc-1"]')
    const item2 = document.querySelector('[data-testid="native-chat-account-item-acc-2"]')
    expect(item1).not.toBeNull()
    expect(item2).not.toBeNull()

    expect(item1?.textContent).toContain('Personal (user1@gmail.com)')
    expect(item2?.textContent).toContain('Work (work@company.com)')

    const check1 = item1?.querySelector('[data-testid="account-selected-check"]')
    const check2 = item2?.querySelector('[data-testid="account-selected-check"]')
    expect(check1).not.toBeNull()
    expect(check2).toBeNull()
  })

  it('calls callAntigravityAccounts with Select and refreshes on selecting account', async () => {
    setCachedAntigravityAccountsState({
      accounts: [account1, account2],
      activeAccountId: 'acc-1',
      selectedAccountId: null,
      currentAccount: null
    })

    const callRpcSpy = vi.spyOn(runtimeClient, 'callAntigravityAccounts').mockResolvedValue({
      accounts: [account1, account2],
      activeAccountId: 'acc-2',
      selectedAccountId: 'acc-2',
      currentAccount: null
    })

    await act(async () => {
      renderWithProviders(<NativeChatAccountSelector agent="antigravity" open={true} />)
    })

    const item2 = document.querySelector<HTMLElement>(
      '[data-testid="native-chat-account-item-acc-2"]'
    )
    expect(item2).not.toBeNull()

    await act(async () => {
      item2?.click()
    })

    expect(callRpcSpy).toHaveBeenCalledWith(
      { kind: 'local' },
      { runtime: 'host' },
      'Select',
      'acc-2'
    )
  })

  it('calls callAntigravityAccounts with AddCurrent when clicking Add Google account', async () => {
    setCachedAntigravityAccountsState({
      accounts: [account1],
      activeAccountId: 'acc-1',
      selectedAccountId: null,
      currentAccount: null
    })

    const callRpcSpy = vi.spyOn(runtimeClient, 'callAntigravityAccounts').mockResolvedValue({
      accounts: [account1],
      activeAccountId: 'acc-1',
      selectedAccountId: null,
      currentAccount: null
    })

    await act(async () => {
      renderWithProviders(<NativeChatAccountSelector agent="antigravity" open={true} />)
    })

    const addItem = document.querySelector<HTMLElement>('[data-testid="native-chat-account-add"]')
    expect(addItem).not.toBeNull()

    await act(async () => {
      addItem?.click()
    })

    expect(callRpcSpy).toHaveBeenCalledWith({ kind: 'local' }, { runtime: 'host' }, 'AddCurrent')
  })

  it('navigates to account settings when clicking Account settings', async () => {
    setCachedAntigravityAccountsState({
      accounts: [account1],
      activeAccountId: 'acc-1',
      selectedAccountId: null,
      currentAccount: null
    })

    await act(async () => {
      renderWithProviders(<NativeChatAccountSelector agent="antigravity" open={true} />)
    })

    const settingsItem = document.querySelector<HTMLElement>(
      '[data-testid="native-chat-account-settings"]'
    )
    expect(settingsItem).not.toBeNull()

    await act(async () => {
      settingsItem?.click()
    })

    const storeState = useAppStore.getState()
    expect(storeState.activeView).toBe('settings')
    expect(storeState.settingsNavigationTarget).toEqual({
      pane: 'accounts',
      repoId: null
    })
  })
})
