// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCachedAntigravityAccountsState } from '@/hooks/useAntigravityAccounts'
import {
  AntigravityAccountSelector,
  CURRENT_ACTIVE_ANTIGRAVITY_ACCOUNT_SENTINEL
} from './AntigravityAccountSelector'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('AntigravityAccountSelector', () => {
  it('renders current active account by default when value is null', async () => {
    setCachedAntigravityAccountsState({
      accounts: [
        {
          id: 'acc-1',
          email: 'user@example.com',
          subject: '123',
          authMethod: 'oauth',
          alias: 'Personal',
          color: '#3b82f6',
          createdAt: 0,
          updatedAt: 0
        }
      ],
      activeAccountId: 'acc-1',
      selectedAccountId: null,
      currentAccount: null
    })

    const onValueChange = vi.fn()

    await act(async () => {
      root.render(<AntigravityAccountSelector value={null} onValueChange={onValueChange} />)
    })

    expect(container.textContent).toContain('Current active account')
    expect(container.textContent).toContain('Personal · user@example.com')
  })

  it('renders active account with emoji when present', async () => {
    setCachedAntigravityAccountsState({
      accounts: [
        {
          id: 'acc-1',
          email: 'user@example.com',
          subject: '123',
          authMethod: 'oauth',
          alias: 'Personal',
          emoji: '🚀',
          color: '#3b82f6',
          createdAt: 0,
          updatedAt: 0
        }
      ],
      activeAccountId: 'acc-1',
      selectedAccountId: null,
      currentAccount: null
    })

    await act(async () => {
      root.render(
        <AntigravityAccountSelector
          value={CURRENT_ACTIVE_ANTIGRAVITY_ACCOUNT_SENTINEL}
          onValueChange={vi.fn()}
        />
      )
    })

    const emojiElement = container.querySelector('[data-account-emoji="🚀"]')
    expect(emojiElement).not.toBeNull()
    expect(emojiElement?.textContent).toBe('🚀')
  })

  it('renders active account with color dot when emoji is not present', async () => {
    setCachedAntigravityAccountsState({
      accounts: [
        {
          id: 'acc-1',
          email: 'user@example.com',
          subject: '123',
          authMethod: 'oauth',
          alias: 'Personal',
          color: '#10b981',
          createdAt: 0,
          updatedAt: 0
        }
      ],
      activeAccountId: 'acc-1',
      selectedAccountId: null,
      currentAccount: null
    })

    await act(async () => {
      root.render(<AntigravityAccountSelector value={null} onValueChange={vi.fn()} />)
    })

    const dotElement = container.querySelector('[data-account-color="#10b981"]')
    expect(dotElement).not.toBeNull()
  })

  it('renders specific saved account with alias and email when value matches', async () => {
    setCachedAntigravityAccountsState({
      accounts: [
        {
          id: 'acc-work',
          email: 'work@example.com',
          subject: '456',
          authMethod: 'oauth',
          alias: 'Work Account',
          color: '#10b981',
          createdAt: 0,
          updatedAt: 0
        }
      ],
      activeAccountId: 'acc-1',
      selectedAccountId: null,
      currentAccount: null
    })

    await act(async () => {
      root.render(<AntigravityAccountSelector value="acc-work" onValueChange={vi.fn()} />)
    })

    expect(container.textContent).toContain('Work Account (work@example.com)')
    const dotElement = container.querySelector('[data-account-color="#10b981"]')
    expect(dotElement).not.toBeNull()
  })

  it('renders saved account with emoji when specified', async () => {
    setCachedAntigravityAccountsState({
      accounts: [
        {
          id: 'acc-star',
          email: 'star@example.com',
          subject: '789',
          authMethod: 'oauth',
          alias: 'Star Account',
          emoji: '⭐',
          createdAt: 0,
          updatedAt: 0
        }
      ],
      activeAccountId: 'acc-1',
      selectedAccountId: null,
      currentAccount: null
    })

    await act(async () => {
      root.render(<AntigravityAccountSelector value="acc-star" onValueChange={vi.fn()} />)
    })

    expect(container.textContent).toContain('Star Account (star@example.com)')
    const emojiElement = container.querySelector('[data-account-emoji="⭐"]')
    expect(emojiElement).not.toBeNull()
    expect(emojiElement?.textContent).toBe('⭐')
  })

  it('renders unlisted unknown account ID fallback', async () => {
    setCachedAntigravityAccountsState({
      accounts: [],
      activeAccountId: null,
      selectedAccountId: null,
      currentAccount: null
    })

    await act(async () => {
      root.render(<AntigravityAccountSelector value="custom-id-99" onValueChange={vi.fn()} />)
    })

    expect(container.textContent).toContain('custom-id-99')
  })

  it('applies disabled state to trigger', async () => {
    setCachedAntigravityAccountsState({
      accounts: [],
      activeAccountId: null,
      selectedAccountId: null,
      currentAccount: null
    })

    await act(async () => {
      root.render(
        <AntigravityAccountSelector value={null} disabled={true} onValueChange={vi.fn()} />
      )
    })

    const trigger = container.querySelector('button[role="combobox"]')
    expect(trigger?.hasAttribute('disabled')).toBe(true)
  })
})
