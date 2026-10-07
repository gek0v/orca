// @vitest-environment happy-dom

import React, { type ReactNode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'

const mocks = vi.hoisted(() => ({
  detectAgents: vi.fn(),
  launchContinuation: vi.fn(),
  settings: { defaultTuiAgent: 'codex', disabledTuiAgents: [] }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({ settings: mocks.settings })
}))
vi.mock('@/lib/launch-agent-session-continuation', () => ({
  detectAgentSessionContinuationAgents: mocks.detectAgents,
  launchAgentSessionContinuation: mocks.launchContinuation
}))
vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => [{ id: 'codex', label: 'Codex' }],
  getAgentLabel: () => 'Codex'
}))
vi.mock('@/components/agent/AgentCombobox', () => ({
  default: ({
    value,
    launchAccountId,
    onLaunchAccountIdChange
  }: {
    value: string | null
    launchAccountId?: string | null
    onLaunchAccountIdChange?: (id: string | null) => void
  }) =>
    React.createElement(
      'div',
      {
        'data-agent': value ?? '',
        'data-launch-account-id': launchAccountId ?? ''
      },
      React.createElement('button', {
        type: 'button',
        'data-testid': 'set-account-btn',
        onClick: () => onLaunchAccountIdChange?.('account-test-id')
      })
    )
}))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? React.createElement('div', null, children) : null,
  DialogContent: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  DialogDescription: ({ children }: { children?: ReactNode }) =>
    React.createElement('p', null, children),
  DialogFooter: ({ children }: { children?: ReactNode }) =>
    React.createElement('footer', null, children),
  DialogHeader: ({ children }: { children?: ReactNode }) =>
    React.createElement('header', null, children),
  DialogTitle: ({ children }: { children?: ReactNode }) => React.createElement('h2', null, children)
}))
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children?: ReactNode }) => React.createElement('div', null, children),
  SelectContent: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  SelectItem: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  SelectTrigger: ({ children }: { children?: ReactNode }) =>
    React.createElement('button', null, children),
  SelectValue: () => React.createElement('span')
}))

import { AgentSessionContinuationDialog } from './AgentSessionContinuationDialog'

function request(worktreeId: string): AgentSessionContinuationRequest {
  return {
    source: { capturedText: 'previous session', sourceAgent: 'codex' },
    worktreeId,
    workspacePath: '/repo',
    launchSource: 'sidebar'
  }
}

describe('AgentSessionContinuationDialog', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('clears a prior detection failure while detecting a new request', async () => {
    let resolveSecond: (agents: ['codex']) => void = () => {}
    mocks.detectAgents.mockRejectedValueOnce(new Error('offline')).mockReturnValueOnce(
      new Promise<['codex']>((resolve) => {
        resolveSecond = resolve
      })
    )

    await act(async () => {
      root.render(
        <AgentSessionContinuationDialog open request={request('wt-1')} onOpenChange={vi.fn()} />
      )
    })
    await vi.waitFor(() => expect(container.textContent).toContain('Could not detect Agents'))

    act(() => {
      root.render(
        <AgentSessionContinuationDialog open request={request('wt-2')} onOpenChange={vi.fn()} />
      )
    })
    expect(container.textContent).toContain('Detecting Agents')
    expect(container.textContent).not.toContain('Could not detect Agents')

    await act(async () => resolveSecond(['codex']))
    await vi.waitFor(() => expect(container.querySelector('[data-agent="codex"]')).not.toBeNull())
  })

  it('tracks launchAccountId and forwards it to launchAgentSessionContinuation', async () => {
    mocks.detectAgents.mockResolvedValue(['codex'])
    mocks.launchContinuation.mockResolvedValue(true)

    await act(async () => {
      root.render(
        <AgentSessionContinuationDialog open request={request('wt-1')} onOpenChange={vi.fn()} />
      )
    })
    await vi.waitFor(() => expect(container.querySelector('[data-agent="codex"]')).not.toBeNull())

    const combobox = container.querySelector('[data-launch-account-id]')
    expect(combobox?.getAttribute('data-launch-account-id')).toBe('')

    const setAccountBtn = container.querySelector('[data-testid="set-account-btn"]')
    expect(setAccountBtn instanceof HTMLButtonElement).toBe(true)
    if (setAccountBtn instanceof HTMLButtonElement) {
      act(() => {
        setAccountBtn.click()
      })
    }

    expect(
      container.querySelector('[data-launch-account-id]')?.getAttribute('data-launch-account-id')
    ).toBe('account-test-id')

    const submitBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Start New Session')
    )
    expect(submitBtn).toBeDefined()
    expect(submitBtn?.disabled).toBe(false)

    await act(async () => {
      submitBtn?.click()
    })

    expect(mocks.launchContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        launchAccountId: 'account-test-id'
      })
    )
  })

  it('resets launchAccountId when a new request is opened', async () => {
    mocks.detectAgents.mockResolvedValue(['codex'])

    await act(async () => {
      root.render(
        <AgentSessionContinuationDialog open request={request('wt-1')} onOpenChange={vi.fn()} />
      )
    })
    await vi.waitFor(() => expect(container.querySelector('[data-agent="codex"]')).not.toBeNull())

    const setAccountBtn = container.querySelector('[data-testid="set-account-btn"]')
    expect(setAccountBtn instanceof HTMLButtonElement).toBe(true)
    if (setAccountBtn instanceof HTMLButtonElement) {
      act(() => {
        setAccountBtn.click()
      })
    }
    expect(
      container.querySelector('[data-launch-account-id]')?.getAttribute('data-launch-account-id')
    ).toBe('account-test-id')

    await act(async () => {
      root.render(
        <AgentSessionContinuationDialog open request={request('wt-2')} onOpenChange={vi.fn()} />
      )
    })
    expect(
      container.querySelector('[data-launch-account-id]')?.getAttribute('data-launch-account-id')
    ).toBe('')
  })
})
