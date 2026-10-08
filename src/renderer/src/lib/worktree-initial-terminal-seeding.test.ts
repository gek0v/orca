import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { ensureWorktreeHasInitialTerminal } from './worktree-initial-terminal-seeding'
import {
  claimEmptyWorkspaceDefaultSurface,
  releaseEmptyWorkspaceDefaultSurface
} from './empty-workspace-default-surface-claims'
import {
  createMockStore,
  registerWorktreeActivationReset
} from './worktree-activation-test-harness'

const defaultChat = vi.hoisted(() => ({
  open: vi.fn()
}))

vi.mock('@/lib/empty-workspace-default-agent-chat', () => ({
  openDefaultAgentChatInEmptyWorkspace: defaultChat.open
}))

const initialAppStoreState = useAppStore.getState()

registerWorktreeActivationReset()

beforeEach(() => {
  defaultChat.open.mockReset()
  useAppStore.setState({
    settings: {
      ...useAppStore.getState().settings!,
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true
    }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  releaseEmptyWorkspaceDefaultSurface('wt-1')
  useAppStore.setState(initialAppStoreState, true)
})

describe('ensureWorktreeHasInitialTerminal', () => {
  it('does not create terminal when callerProvidesSurface is true', () => {
    const createTab = vi.fn()
    const store = createMockStore({ createTab })

    const result = ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      undefined,
      undefined,
      undefined,
      undefined,
      { callerProvidesSurface: true }
    )

    expect(result).toBeNull()
    expect(createTab).not.toHaveBeenCalled()
  })

  it('prioritizes opening default agent chat when seedUserDefaultSurface is true', () => {
    defaultChat.open.mockReturnValue({ primaryTabId: 'chat-tab-1' })
    const createTab = vi.fn(() => ({ id: 'shell-tab' }))
    const store = createMockStore({ createTab })

    const result = ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      undefined,
      undefined,
      undefined,
      undefined,
      { seedUserDefaultSurface: true }
    )

    expect(defaultChat.open).toHaveBeenCalledWith('wt-1')
    expect(result).toBe('chat-tab-1')
    expect(createTab).not.toHaveBeenCalled()
  })

  it('does not spawn secondary terminal if chat surface is created', () => {
    defaultChat.open.mockReturnValue({ primaryTabId: null })
    const createTab = vi.fn(() => ({ id: 'shell-tab' }))
    const store = createMockStore({ createTab })

    const result = ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      undefined,
      undefined,
      undefined,
      undefined,
      { seedUserDefaultSurface: true }
    )

    expect(defaultChat.open).toHaveBeenCalledWith('wt-1')
    expect(result).toBeNull()
    expect(createTab).not.toHaveBeenCalled()
  })

  it('does not spawn terminal when renderableTabCount > 0', () => {
    const createTab = vi.fn(() => ({ id: 'shell-tab' }))
    const store = createMockStore({
      createTab,
      reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 1 }))
    })

    const result = ensureWorktreeHasInitialTerminal(store, 'wt-1')

    expect(result).toBeNull()
    expect(createTab).not.toHaveBeenCalled()
    expect(defaultChat.open).not.toHaveBeenCalled()
  })

  it('does not spawn terminal when store already has tabs for worktree', () => {
    const createTab = vi.fn(() => ({ id: 'shell-tab' }))
    const store = createMockStore({
      createTab,
      tabsByWorktree: { 'wt-1': [{ id: 'existing-tab' }] },
      reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 0 }))
    })

    const result = ensureWorktreeHasInitialTerminal(store, 'wt-1')

    expect(result).toBeNull()
    expect(createTab).not.toHaveBeenCalled()
  })

  it('does not spawn terminal when workspace default surface is pending hydration/detection', () => {
    claimEmptyWorkspaceDefaultSurface('wt-1', {
      callerProvidesSurface: false,
      seedUserDefaultSurface: true
    })
    const createTab = vi.fn(() => ({ id: 'shell-tab' }))
    const store = createMockStore({ createTab })

    const result = ensureWorktreeHasInitialTerminal(store, 'wt-1')

    expect(result).toBeNull()
    expect(createTab).not.toHaveBeenCalled()
  })

  it('falls back to initial shell terminal when chat cannot open', () => {
    defaultChat.open.mockReturnValue(null)
    const createTab = vi.fn(() => ({ id: 'shell-tab' }))
    const store = createMockStore({ createTab })

    const result = ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      undefined,
      undefined,
      undefined,
      undefined,
      { seedUserDefaultSurface: true }
    )

    expect(defaultChat.open).toHaveBeenCalledWith('wt-1')
    expect(result).toBe('shell-tab')
    expect(createTab).toHaveBeenCalledTimes(1)
  })
})
