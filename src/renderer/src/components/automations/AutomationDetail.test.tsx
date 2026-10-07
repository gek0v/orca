// @vitest-environment happy-dom

/**
 * A record Orca switched off used to be indistinguishable from one the user
 * switched off — same "Paused", no reason, no next step. These pin the one new
 * state to the migration's own stamp, and pin the other two to reading exactly
 * as they did before it existed.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Automation } from '../../../../shared/automations-types'
import { setCachedAntigravityAccountsState } from '@/hooks/useAntigravityAccounts'
import { AutomationDetail } from './AutomationDetail'
import { makeAutomation } from './automations-page-fixtures'

const roots: Root[] = []

async function render(overrides: Partial<Automation>): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <TooltipProvider>
        <AutomationDetail
          automation={makeAutomation(overrides)}
          runs={[]}
          projectName="orca"
          workspaceName="main"
          projectDefaultBaseRef="main"
          runNowAvailability={null}
          now={0}
          onRunNow={vi.fn()}
          onEdit={vi.fn()}
          onToggle={vi.fn()}
          onDelete={vi.fn()}
        />
      </TooltipProvider>
    )
  })
  return container
}

function notice(container: HTMLDivElement): HTMLElement | null {
  return container.querySelector('[data-testid="automation-enablement-notice"]')
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((root) => root.unmount())
  })
  document.body.innerHTML = ''
})

describe('AutomationDetail enablement', () => {
  it('shows a paused record as a plain pause', async () => {
    const container = await render({ enabled: false })

    expect(container.textContent).toContain('Paused')
    expect(notice(container)).toBeNull()
  })

  it('shows a running automation as enabled', async () => {
    const container = await render({ enabled: true })

    expect(container.textContent).toContain('Enabled')
    expect(notice(container)).toBeNull()
  })

  it('renders account details when agent is antigravity and has launchAccountId', async () => {
    setCachedAntigravityAccountsState({
      accounts: [
        {
          id: 'acc-1',
          email: 'test@example.com',
          subject: '123',
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

    const container = await render({
      agentId: 'antigravity',
      launchAccountId: 'acc-1'
    })

    expect(container.textContent).toContain('Work Account (test@example.com)')
  })

  it('renders current active account when agent is antigravity without explicit launchAccountId', async () => {
    setCachedAntigravityAccountsState({
      accounts: [
        {
          id: 'acc-1',
          email: 'active@example.com',
          subject: '123',
          authMethod: 'oauth',
          alias: 'Active',
          color: '#3b82f6',
          createdAt: 0,
          updatedAt: 0
        }
      ],
      activeAccountId: 'acc-1',
      selectedAccountId: null,
      currentAccount: null
    })

    const container = await render({
      agentId: 'antigravity',
      launchAccountId: null
    })

    expect(container.textContent).toContain('Current active account')
  })
})
