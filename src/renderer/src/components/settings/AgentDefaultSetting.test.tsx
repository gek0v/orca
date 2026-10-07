// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { setCachedAntigravityAccountsState } from '@/hooks/useAntigravityAccounts'
import { AgentDefaultSetting } from './AgentDefaultSetting'

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

describe('AgentDefaultSetting', () => {
  const catalog = getAgentCatalog()
  const enabledDetectedAgents = catalog.filter((a) => a.id === 'antigravity' || a.id === 'claude')
  const detectedIds = new Set(['antigravity', 'claude'])

  beforeEach(() => {
    setCachedAntigravityAccountsState({
      accounts: [
        {
          id: 'acc-work',
          email: 'work@example.com',
          subject: '123',
          authMethod: 'oauth',
          alias: 'Work Account',
          color: '#10b981',
          createdAt: 0,
          updatedAt: 0
        }
      ],
      activeAccountId: 'acc-work',
      selectedAccountId: null,
      currentAccount: null
    })
  })

  it('does not render AntigravityAccountSelector when defaultAgent is null or claude', async () => {
    await act(async () => {
      root.render(
        <AgentDefaultSetting
          defaultAgent="claude"
          detectedIds={detectedIds}
          enabledDetectedAgents={enabledDetectedAgents}
          catalog={catalog}
          description="Default agent description"
          onSetDefault={vi.fn()}
        />
      )
    })

    expect(
      container.querySelector('[data-testid="antigravity-account-selector-trigger"]')
    ).toBeNull()
  })

  it('renders AntigravityAccountSelector when defaultAgent is antigravity', async () => {
    await act(async () => {
      root.render(
        <AgentDefaultSetting
          defaultAgent="antigravity"
          detectedIds={detectedIds}
          enabledDetectedAgents={enabledDetectedAgents}
          catalog={catalog}
          description="Default agent description"
          onSetDefault={vi.fn()}
        />
      )
    })

    const trigger = container.querySelector('[data-testid="antigravity-account-selector-trigger"]')
    expect(trigger).not.toBeNull()
    expect(container.textContent).toContain('Current active account')
  })

  it('renders selected Antigravity account and notifies change', async () => {
    const onSetDefaultAntigravityAccountId = vi.fn()

    await act(async () => {
      root.render(
        <AgentDefaultSetting
          defaultAgent="antigravity"
          detectedIds={detectedIds}
          enabledDetectedAgents={enabledDetectedAgents}
          catalog={catalog}
          description="Default agent description"
          onSetDefault={vi.fn()}
          defaultAntigravityAccountId="acc-work"
          onSetDefaultAntigravityAccountId={onSetDefaultAntigravityAccountId}
        />
      )
    })

    expect(container.textContent).toContain('Work Account (work@example.com)')
  })
})
