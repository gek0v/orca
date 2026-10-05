// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCachedAntigravityAccountsState } from '@/hooks/useAntigravityAccounts'
import { AutomationAntigravityAccountField } from './AutomationAntigravityAccountField'
import type { AutomationDraft } from './AutomationEditorDialog'

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

const BASE_DRAFT: AutomationDraft = {
  name: 'Test',
  prompt: 'Do something',
  agentId: 'antigravity',
  launchAccountId: null,
  projectId: 'repo-1',
  workspaceMode: 'existing',
  workspaceId: 'wt-1',
  baseBranch: '',
  reuseSession: false,
  precheckCommand: '',
  precheckTimeoutSeconds: '60',
  preset: 'weekdays',
  time: '09:00',
  dayOfWeek: '1',
  customSchedule: '',
  savedSchedule: null,
  missedRunGraceMinutes: '720',
  scheduleWarning: null
}

describe('AutomationAntigravityAccountField', () => {
  it('renders with current active account display by default', async () => {
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

    const onDraftChange = vi.fn()

    await act(async () => {
      root.render(
        <AutomationAntigravityAccountField
          draft={BASE_DRAFT}
          onDraftChange={onDraftChange}
        />
      )
    })

    expect(container.textContent).toContain('Account')
    expect(container.textContent).toContain('Current active account')
  })

  it('renders specific account when draft has launchAccountId', async () => {
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

    const onDraftChange = vi.fn()

    await act(async () => {
      root.render(
        <AutomationAntigravityAccountField
          draft={{ ...BASE_DRAFT, launchAccountId: 'acc-work' }}
          onDraftChange={onDraftChange}
        />
      )
    })

    expect(container.textContent).toContain('Work Account (work@example.com)')
  })
})
