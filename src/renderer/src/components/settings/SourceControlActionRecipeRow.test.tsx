// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCachedAntigravityAccountsState } from '@/hooks/useAntigravityAccounts'
import { CUSTOM_AGENT_ID } from '../../../../shared/commit-message-agent-spec'
import { SourceControlActionRecipeRow } from './SourceControlActionRecipeRow'

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

describe('SourceControlActionRecipeRow', () => {
  const baseValue = {
    commandInputTemplate: '{basePrompt}',
    agentArgs: '',
    launchAccountId: null
  }

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

  it('does not render AntigravityAccountSelector when selected agent is claude', async () => {
    await act(async () => {
      root.render(
        <SourceControlActionRecipeRow
          actionId="commitMessage"
          selectedAgent="claude"
          draftValue={baseValue}
          baseValue={baseValue}
          defaultTuiAgent="codex"
          isSavingTemplate={false}
          onAgentChange={vi.fn()}
          onTemplateChange={vi.fn()}
          onAgentArgsChange={vi.fn()}
          onAppendVariable={vi.fn()}
          onDiscard={vi.fn()}
          onSave={vi.fn()}
        />
      )
    })

    expect(
      container.querySelector('[data-testid="antigravity-account-selector-trigger"]')
    ).toBeNull()
  })

  it('renders AntigravityAccountSelector when selectedAgent is antigravity', async () => {
    await act(async () => {
      root.render(
        <SourceControlActionRecipeRow
          actionId="commitMessage"
          selectedAgent="antigravity"
          draftValue={{ ...baseValue, launchAccountId: 'acc-work' }}
          baseValue={baseValue}
          defaultTuiAgent="claude"
          isSavingTemplate={false}
          onAgentChange={vi.fn()}
          onTemplateChange={vi.fn()}
          onAgentArgsChange={vi.fn()}
          onAppendVariable={vi.fn()}
          onDiscard={vi.fn()}
          onSave={vi.fn()}
        />
      )
    })

    const trigger = container.querySelector('[data-testid="antigravity-account-selector-trigger"]')
    expect(trigger).not.toBeNull()
    expect(container.textContent).toContain('Work Account (work@example.com)')
  })

  it('renders AntigravityAccountSelector when selectedAgent is null and defaultTuiAgent is antigravity', async () => {
    await act(async () => {
      root.render(
        <SourceControlActionRecipeRow
          actionId="commitMessage"
          selectedAgent={null}
          draftValue={baseValue}
          baseValue={baseValue}
          defaultTuiAgent="antigravity"
          isSavingTemplate={false}
          onAgentChange={vi.fn()}
          onTemplateChange={vi.fn()}
          onAgentArgsChange={vi.fn()}
          onAppendVariable={vi.fn()}
          onDiscard={vi.fn()}
          onSave={vi.fn()}
        />
      )
    })

    const trigger = container.querySelector('[data-testid="antigravity-account-selector-trigger"]')
    expect(trigger).not.toBeNull()
  })

  it('does not render AntigravityAccountSelector when selectedAgent is custom command even if default is antigravity', async () => {
    await act(async () => {
      root.render(
        <SourceControlActionRecipeRow
          actionId="commitMessage"
          selectedAgent={CUSTOM_AGENT_ID}
          draftValue={baseValue}
          baseValue={baseValue}
          defaultTuiAgent="antigravity"
          isSavingTemplate={false}
          onAgentChange={vi.fn()}
          onTemplateChange={vi.fn()}
          onAgentArgsChange={vi.fn()}
          onAppendVariable={vi.fn()}
          onDiscard={vi.fn()}
          onSave={vi.fn()}
        />
      )
    })

    expect(
      container.querySelector('[data-testid="antigravity-account-selector-trigger"]')
    ).toBeNull()
  })
})
