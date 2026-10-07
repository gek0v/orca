// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import {
  type AntigravityTabLookupState,
  findActiveAntigravityTab,
  findAntigravityTabById,
  switchAntigravityAccountAndRestartSession
} from './antigravity-session-restart'

const mocks = vi.hoisted(() => ({
  callAntigravityAccounts: vi.fn(),
  setCachedAntigravityAccountsState: vi.fn(),
  launchAgentInNewTab: vi.fn(),
  newAgentLaunchRequestId: vi.fn(() => 'test-req-123'),
  closeTab: vi.fn(),
  refreshRateLimits: vi.fn()
}))

type MockStoreState = {
  closeTab: (tabId: string) => void
  refreshRateLimits?: () => void
  tabsByWorktree?: Record<string, TerminalTab[]>
  unifiedTabsByWorktree?: Record<string, Tab[]>
  activeWorktreeId?: string
  activeTabIdByWorktree?: Record<string, string | null>
  activeTabId?: string
}

const mockStoreState: MockStoreState = {
  closeTab: mocks.closeTab,
  refreshRateLimits: mocks.refreshRateLimits,
  tabsByWorktree: {},
  unifiedTabsByWorktree: {},
  activeWorktreeId: undefined,
  activeTabIdByWorktree: {},
  activeTabId: undefined
}

vi.mock('@/runtime/runtime-antigravity-accounts-client', () => ({
  callAntigravityAccounts: mocks.callAntigravityAccounts
}))

vi.mock('@/hooks/useAntigravityAccounts', () => ({
  setCachedAntigravityAccountsState: mocks.setCachedAntigravityAccountsState
}))

vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: mocks.launchAgentInNewTab
}))

vi.mock('@/lib/agent-launch-request-id', () => ({
  newAgentLaunchRequestId: mocks.newAgentLaunchRequestId
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState
  }
}))

function createTerminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: overrides.id ?? 't1',
    ptyId: overrides.ptyId ?? null,
    worktreeId: overrides.worktreeId ?? 'w1',
    title: overrides.title ?? 'Terminal',
    customTitle: overrides.customTitle ?? null,
    color: overrides.color ?? null,
    sortOrder: overrides.sortOrder ?? 0,
    createdAt: overrides.createdAt ?? 12345,
    ...overrides
  }
}

function createUnifiedTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: overrides.id ?? 'u1',
    entityId: overrides.entityId ?? 't1',
    groupId: overrides.groupId ?? 'grp-1',
    worktreeId: overrides.worktreeId ?? 'w1',
    contentType: overrides.contentType ?? 'terminal',
    label: overrides.label ?? 'Terminal',
    customLabel: overrides.customLabel ?? null,
    color: overrides.color ?? null,
    sortOrder: overrides.sortOrder ?? 0,
    createdAt: overrides.createdAt ?? 12345,
    ...overrides
  }
}

describe('antigravity-session-restart', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStoreState.tabsByWorktree = {}
    mockStoreState.unifiedTabsByWorktree = {}
    mockStoreState.activeWorktreeId = undefined
    mockStoreState.activeTabIdByWorktree = {}
    mockStoreState.activeTabId = undefined
  })

  describe('findActiveAntigravityTab', () => {
    it('returns null if there are no tabs or no antigravity tabs', () => {
      const state: AntigravityTabLookupState = {
        tabsByWorktree: {
          w1: [
            createTerminalTab({ id: 't1', launchAgent: undefined }),
            createTerminalTab({ id: 't2', launchAgent: 'claude' })
          ]
        },
        unifiedTabsByWorktree: {},
        activeWorktreeId: 'w1',
        activeTabIdByWorktree: { w1: 't1' }
      }

      expect(findActiveAntigravityTab(state)).toBeNull()
    })

    it('returns the active antigravity tab in the active worktree', () => {
      const tab1 = createTerminalTab({ id: 't1', launchAgent: 'antigravity', startupCwd: '/repo' })
      const tab2 = createTerminalTab({ id: 't2', launchAgent: 'antigravity' })
      const state: AntigravityTabLookupState = {
        tabsByWorktree: {
          w1: [tab1, tab2]
        },
        unifiedTabsByWorktree: {
          w1: [
            createUnifiedTab({ contentType: 'terminal', entityId: 't1', groupId: 'group-1' }),
            createUnifiedTab({ contentType: 'terminal', entityId: 't2', groupId: 'group-2' })
          ]
        },
        activeWorktreeId: 'w1',
        activeTabIdByWorktree: { w1: 't1' }
      }

      const result = findActiveAntigravityTab(state)
      expect(result).toEqual({
        tab: tab1,
        worktreeId: 'w1',
        groupId: 'group-1'
      })
    })

    it('falls back to any antigravity tab in active worktree if active tab is not antigravity', () => {
      const tab2 = createTerminalTab({
        id: 't2',
        launchAgent: 'antigravity',
        startupCwd: '/workspace'
      })
      const state: AntigravityTabLookupState = {
        tabsByWorktree: {
          w1: [createTerminalTab({ id: 't1', launchAgent: undefined }), tab2]
        },
        unifiedTabsByWorktree: {
          w1: [createUnifiedTab({ contentType: 'terminal', entityId: 't2', groupId: 'group-xyz' })]
        },
        activeWorktreeId: 'w1',
        activeTabIdByWorktree: { w1: 't1' }
      }

      const result = findActiveAntigravityTab(state)
      expect(result).toEqual({
        tab: tab2,
        worktreeId: 'w1',
        groupId: 'group-xyz'
      })
    })

    it('falls back to an antigravity tab in another worktree if active worktree has none', () => {
      const tab2 = createTerminalTab({ id: 't2', launchAgent: 'antigravity' })
      const state: AntigravityTabLookupState = {
        tabsByWorktree: {
          w1: [createTerminalTab({ id: 't1', launchAgent: undefined })],
          w2: [tab2]
        },
        unifiedTabsByWorktree: {
          w2: [createUnifiedTab({ contentType: 'terminal', entityId: 't2', groupId: 'group-w2' })]
        },
        activeWorktreeId: 'w1'
      }

      const result = findActiveAntigravityTab(state)
      expect(result).toEqual({
        tab: tab2,
        worktreeId: 'w2',
        groupId: 'group-w2'
      })
    })

    it('handles undefined store structures without crashing', () => {
      const state: AntigravityTabLookupState = {}
      expect(findActiveAntigravityTab(state)).toBeNull()
    })
  })

  describe('findAntigravityTabById', () => {
    it('returns tab by id across worktrees with matched group', () => {
      const tabTarget = createTerminalTab({
        id: 'target-tab',
        launchAgent: 'antigravity',
        startupCwd: '/path'
      })
      const state: AntigravityTabLookupState = {
        tabsByWorktree: {
          w1: [createTerminalTab({ id: 't1', launchAgent: 'antigravity' })],
          w2: [tabTarget]
        },
        unifiedTabsByWorktree: {
          w2: [
            createUnifiedTab({
              contentType: 'terminal',
              entityId: 'target-tab',
              groupId: 'grp-found'
            })
          ]
        }
      }

      const result = findAntigravityTabById(state, 'target-tab')
      expect(result).toEqual({
        tab: tabTarget,
        worktreeId: 'w2',
        groupId: 'grp-found'
      })
    })

    it('constructs a fallback tab when only unifiedTabsByWorktree has the tab', () => {
      const state: AntigravityTabLookupState = {
        tabsByWorktree: {},
        unifiedTabsByWorktree: {
          w1: [
            createUnifiedTab({
              contentType: 'terminal',
              entityId: 'orphan-tab',
              groupId: 'grp-orphan',
              customLabel: 'My Agent'
            })
          ]
        }
      }

      const result = findAntigravityTabById(state, 'orphan-tab')
      expect(result?.worktreeId).toBe('w1')
      expect(result?.groupId).toBe('grp-orphan')
      expect(result?.tab.id).toBe('orphan-tab')
      expect(result?.tab.title).toBe('My Agent')
    })

    it('returns null if tab id does not exist', () => {
      const state: AntigravityTabLookupState = {
        tabsByWorktree: {},
        unifiedTabsByWorktree: {}
      }

      expect(findAntigravityTabById(state, 'missing-id')).toBeNull()
    })
  })

  describe('switchAntigravityAccountAndRestartSession', () => {
    it('switches account, closes active tab, and launches a fresh antigravity tab', async () => {
      const mockResult = {
        activeAccountId: 'acc-2',
        accounts: [{ id: 'acc-2', name: 'Work' }]
      }
      mocks.callAntigravityAccounts.mockResolvedValueOnce(mockResult)

      const tab1 = createTerminalTab({
        id: 't1',
        launchAgent: 'antigravity',
        startupCwd: '/project'
      })
      mockStoreState.tabsByWorktree = {
        w1: [tab1]
      }
      mockStoreState.unifiedTabsByWorktree = {
        w1: [createUnifiedTab({ contentType: 'terminal', entityId: 't1', groupId: 'group-1' })]
      }
      mockStoreState.activeWorktreeId = 'w1'
      mockStoreState.activeTabIdByWorktree = { w1: 't1' }

      const res = await switchAntigravityAccountAndRestartSession({
        targetAccountId: 'acc-2'
      })

      expect(res).toEqual({ restarted: true })
      expect(mocks.callAntigravityAccounts).toHaveBeenCalledWith(
        { kind: 'local' },
        { runtime: 'host' },
        'Select',
        'acc-2'
      )
      expect(mocks.setCachedAntigravityAccountsState).toHaveBeenCalledWith(mockResult)
      expect(mocks.refreshRateLimits).toHaveBeenCalled()
      expect(mocks.closeTab).toHaveBeenCalledWith('t1')
      expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith({
        requestId: 'test-req-123',
        agent: 'antigravity',
        worktreeId: 'w1',
        launchAccountId: 'acc-2',
        groupId: 'group-1',
        initialCwd: '/project',
        launchSource: 'tab_bar_quick_launch'
      })
    })

    it('targets specific tabId when provided', async () => {
      mocks.callAntigravityAccounts.mockResolvedValueOnce({})
      const tab2 = createTerminalTab({
        id: 't2',
        launchAgent: 'antigravity',
        startupCwd: '/other'
      })
      mockStoreState.tabsByWorktree = {
        w1: [createTerminalTab({ id: 't1', launchAgent: 'antigravity' }), tab2]
      }
      mockStoreState.unifiedTabsByWorktree = {
        w1: [createUnifiedTab({ contentType: 'terminal', entityId: 't2', groupId: 'group-2' })]
      }
      mockStoreState.activeWorktreeId = 'w1'
      mockStoreState.activeTabIdByWorktree = { w1: 't1' }

      const res = await switchAntigravityAccountAndRestartSession({
        targetAccountId: 'acc-3',
        tabId: 't2'
      })

      expect(res).toEqual({ restarted: true })
      expect(mocks.closeTab).toHaveBeenCalledWith('t2')
      expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreeId: 'w1',
          launchAccountId: 'acc-3',
          groupId: 'group-2',
          initialCwd: '/other'
        })
      )
    })

    it('returns restarted: false if no antigravity tab was located', async () => {
      mocks.callAntigravityAccounts.mockResolvedValueOnce({})
      mockStoreState.tabsByWorktree = {}
      mockStoreState.unifiedTabsByWorktree = {}

      const res = await switchAntigravityAccountAndRestartSession({
        targetAccountId: 'acc-2'
      })

      expect(res).toEqual({ restarted: false })
      expect(mocks.closeTab).not.toHaveBeenCalled()
      expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
    })
  })
})
