// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getCachedAntigravityAccountsState,
  refreshAntigravityAccounts,
  setCachedAntigravityAccountsState,
  useActiveWindowAntigravityAccount,
  useAntigravityAccounts
} from './useAntigravityAccounts'
import { callAntigravityAccounts } from '@/runtime/runtime-antigravity-accounts-client'
import type {
  AntigravityAccountState,
  AntigravityAccountSummary
} from '../../../shared/antigravity-account-types'

vi.mock('@/runtime/runtime-antigravity-accounts-client', () => ({
  callAntigravityAccounts: vi.fn()
}))

type MockStoreState = {
  activeTabId?: string | null
  activePaneId?: string | number | null
  activeWorktreeId?: string | null
  activeRepoId?: string | null
  repos?: { id: string; antigravityAccountId?: string | null }[]
  unifiedTabsByWorktree?: Record<
    string,
    {
      id: string
      entityId?: string
      launchAgent?: string
      launchAccountId?: string
      contentType?: string
    }[]
  >
  tabsByWorktree?: Record<
    string,
    {
      id: string
      launchAgent?: string
      launchAccountId?: string
    }[]
  >
}

let mockStoreState: MockStoreState = {}

vi.mock('@/store', () => ({
  useAppStore: (selector: (s: MockStoreState) => unknown) => selector(mockStoreState)
}))

function makeAccount(id: string, alias: string): AntigravityAccountSummary {
  return {
    id,
    email: `${id}@example.com`,
    subject: `sub-${id}`,
    authMethod: 'oauth',
    alias,
    emoji: '💼',
    color: null,
    createdAt: 1000,
    updatedAt: 1000,
    lastUsage: null,
    lastUsageAt: null
  }
}

describe('refreshAntigravityAccounts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setCachedAntigravityAccountsState(null)
    mockStoreState = {}
  })

  it('deduplicates concurrent in-flight requests', async () => {
    const mockState: AntigravityAccountState = {
      activeAccountId: 'acc-1',
      accounts: [makeAccount('acc-1', 'Work')],
      currentAccount: null,
      selectedAccountId: null
    }

    let resolveCall: (res: AntigravityAccountState) => void = () => {}
    const deferredPromise = new Promise<AntigravityAccountState>((resolve) => {
      resolveCall = resolve
    })

    vi.mocked(callAntigravityAccounts).mockReturnValue(deferredPromise)

    const call1 = refreshAntigravityAccounts()
    const call2 = refreshAntigravityAccounts()

    expect(callAntigravityAccounts).toHaveBeenCalledTimes(1)
    expect(call1).toBe(call2)

    resolveCall(mockState)

    const [res1, res2] = await Promise.all([call1, call2])
    expect(res1).toEqual(mockState)
    expect(res2).toEqual(mockState)

    // After completion, next call makes a new request
    vi.mocked(callAntigravityAccounts).mockResolvedValueOnce(mockState)
    await refreshAntigravityAccounts()
    expect(callAntigravityAccounts).toHaveBeenCalledTimes(2)
  })
})

describe('useActiveWindowAntigravityAccount', () => {
  const acc1 = makeAccount('acc-1', 'Global Active')
  const acc2 = makeAccount('acc-2', 'Tab Account')
  const acc3 = makeAccount('acc-3', 'Pane Account')
  const accRepo = makeAccount('acc-repo', 'Repo Bound Account')

  const baseState: AntigravityAccountState = {
    activeAccountId: 'acc-1',
    accounts: [acc1, acc2, acc3, accRepo],
    currentAccount: null,
    selectedAccountId: 'acc-1'
  }

  beforeEach(() => {
    vi.clearAllMocks()
    setCachedAntigravityAccountsState(baseState)
    mockStoreState = {}
  })

  it('resolves the account when activeTabId matches a unified tab with launchAgent antigravity and launchAccountId', () => {
    mockStoreState = {
      activeTabId: 'unified-tab-1',
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'unified-tab-1',
            launchAgent: 'antigravity',
            launchAccountId: 'acc-2'
          }
        ]
      }
    }

    const { result } = renderHook(() => useActiveWindowAntigravityAccount())
    expect(result.current?.id).toBe('acc-2')
  })

  // Review Focus #5: activePaneId returns immediately on focused split pane
  it('resolves immediately to focused split pane account when activePaneId matches', () => {
    mockStoreState = {
      activeTabId: 'unified-tab-1',
      activePaneId: 'split-leaf-pane-3',
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'unified-tab-1',
            launchAgent: 'antigravity',
            launchAccountId: 'acc-2'
          },
          {
            id: 'split-leaf-pane-3',
            launchAgent: 'antigravity',
            launchAccountId: 'acc-3'
          }
        ]
      }
    }

    const { result } = renderHook(() => useActiveWindowAntigravityAccount())
    expect(result.current?.id).toBe('acc-3')
  })

  it('falls back to repo binding when active tab is non-Antigravity', () => {
    mockStoreState = {
      activeTabId: 'editor-tab-1',
      activeWorktreeId: 'repo-1::/path/wt',
      repos: [{ id: 'repo-1', antigravityAccountId: 'acc-repo' }],
      unifiedTabsByWorktree: {
        'repo-1::/path/wt': [
          {
            id: 'editor-tab-1',
            contentType: 'editor'
          }
        ]
      }
    }

    const { result } = renderHook(() => useActiveWindowAntigravityAccount())
    expect(result.current?.id).toBe('acc-repo')
  })

  it('falls back to repo binding when active tab is Antigravity without launchAccountId', () => {
    mockStoreState = {
      activeTabId: 'tab-unbound',
      activeWorktreeId: 'repo-1::/path/wt',
      repos: [{ id: 'repo-1', antigravityAccountId: 'acc-repo' }],
      unifiedTabsByWorktree: {
        'repo-1::/path/wt': [
          {
            id: 'tab-unbound',
            launchAgent: 'antigravity'
          }
        ]
      }
    }

    const { result } = renderHook(() => useActiveWindowAntigravityAccount())
    expect(result.current?.id).toBe('acc-repo')
  })

  it('falls back to global active account when active tab has no account and repo has no binding', () => {
    mockStoreState = {
      activeTabId: 'editor-tab-1',
      activeWorktreeId: 'repo-1::/path/wt',
      repos: [{ id: 'repo-1', antigravityAccountId: null }],
      unifiedTabsByWorktree: {
        'repo-1::/path/wt': [
          {
            id: 'editor-tab-1',
            contentType: 'editor'
          }
        ]
      }
    }

    const { result } = renderHook(() => useActiveWindowAntigravityAccount())
    expect(result.current?.id).toBe('acc-1')
  })
})

describe('useAntigravityAccounts IPC listener', () => {
  const initialAcc = makeAccount('acc-init', 'Initial')
  const nextAcc = makeAccount('acc-next', 'Next')

  beforeEach(() => {
    vi.clearAllMocks()
    setCachedAntigravityAccountsState({
      activeAccountId: 'acc-init',
      accounts: [initialAcc],
      currentAccount: null,
      selectedAccountId: 'acc-init'
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'api')
  })

  it('updates cachedState and notifies listeners when antigravity-accounts-changed event is received', () => {
    let capturedCallback: ((state: AntigravityAccountState) => void) | null = null
    const unsubscribeMock = vi.fn()

    Object.defineProperty(window, 'api', {
      value: {
        antigravityAccounts: {
          onAccountsChanged: vi.fn((cb) => {
            capturedCallback = cb
            return unsubscribeMock
          })
        }
      },
      configurable: true,
      writable: true
    })

    const { result, unmount } = renderHook(() => useAntigravityAccounts())
    expect(result.current.activeAccount?.id).toBe('acc-init')

    const updatedState: AntigravityAccountState = {
      activeAccountId: 'acc-next',
      accounts: [nextAcc],
      currentAccount: null,
      selectedAccountId: 'acc-next'
    }

    act(() => {
      capturedCallback?.(updatedState)
    })

    expect(result.current.activeAccount?.id).toBe('acc-next')
    expect(getCachedAntigravityAccountsState()?.activeAccountId).toBe('acc-next')

    unmount()
    expect(unsubscribeMock).toHaveBeenCalled()
  })
})
