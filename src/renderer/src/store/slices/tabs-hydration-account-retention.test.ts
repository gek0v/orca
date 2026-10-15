import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { buildHydratedTabState } from './tabs-hydration'
import { sleepingRecordFromEntry } from './agent-status-sleeping-records'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { createTestStore } from './store-test-helpers'

function makeBaseSession(): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
}

describe('tabs-hydration account retention', () => {
  it('retains launchAccountId and launchAgent on unified tabs', () => {
    const session: WorkspaceSessionState = {
      ...makeBaseSession(),
      tabsByWorktree: {
        w1: [
          {
            id: 't1',
            ptyId: null,
            worktreeId: 'w1',
            title: 'agy',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            launchAgent: 'antigravity',
            launchAccountId: 'acc-1'
          }
        ]
      },
      unifiedTabs: {
        w1: [
          {
            id: 't1',
            entityId: 't1',
            groupId: 'g1',
            worktreeId: 'w1',
            contentType: 'terminal',
            label: 'agy',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            launchAgent: 'antigravity',
            launchAccountId: 'acc-1'
          }
        ]
      },
      tabGroups: {
        w1: [{ id: 'g1', worktreeId: 'w1', activeTabId: 't1', tabOrder: ['t1'] }]
      }
    }

    const result = buildHydratedTabState(session, new Set(['w1']))

    expect(result.unifiedTabsByWorktree.w1[0].launchAccountId).toBe('acc-1')
    expect(result.unifiedTabsByWorktree.w1[0].launchAgent).toBe('antigravity')
  })

  it('falls back to terminalTab launchAccountId and launchAgent when unified tab omits them', () => {
    const session: WorkspaceSessionState = {
      ...makeBaseSession(),
      tabsByWorktree: {
        w1: [
          {
            id: 't1',
            ptyId: null,
            worktreeId: 'w1',
            title: 'agy',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            launchAgent: 'antigravity',
            launchAccountId: 'acc-2'
          }
        ]
      },
      unifiedTabs: {
        w1: [
          {
            id: 't1',
            entityId: 't1',
            groupId: 'g1',
            worktreeId: 'w1',
            contentType: 'terminal',
            label: 'agy',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        w1: [{ id: 'g1', worktreeId: 'w1', activeTabId: 't1', tabOrder: ['t1'] }]
      }
    }

    const result = buildHydratedTabState(session, new Set(['w1']))

    expect(result.unifiedTabsByWorktree.w1[0].launchAccountId).toBe('acc-2')
    expect(result.unifiedTabsByWorktree.w1[0].launchAgent).toBe('antigravity')
  })

  it('copies launchAccountId and launchAgent from legacy terminal tabs', () => {
    const session: WorkspaceSessionState = {
      ...makeBaseSession(),
      tabsByWorktree: {
        w1: [
          {
            id: 't1',
            ptyId: null,
            worktreeId: 'w1',
            title: 'agy',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            launchAgent: 'antigravity',
            launchAccountId: 'acc-3'
          }
        ]
      }
    }

    const result = buildHydratedTabState(session, new Set(['w1']))

    expect(result.unifiedTabsByWorktree.w1[0].launchAccountId).toBe('acc-3')
    expect(result.unifiedTabsByWorktree.w1[0].launchAgent).toBe('antigravity')
  })

  it('captures launchAccountId from terminal tab in sleepingRecordFromEntry', () => {
    const entry: AgentStatusEntry = {
      paneKey: 'w1:t1',
      worktreeId: 'w1',
      agentType: 'antigravity',
      state: 'working',
      prompt: 'do work',
      providerSession: { key: 'conversation_id', id: 'conv-123' },
      updatedAt: 1000
    }
    const tab: TerminalTab = {
      id: 't1',
      ptyId: 'pty-1',
      worktreeId: 'w1',
      title: 'agy',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1,
      launchAgent: 'antigravity',
      launchAccountId: 'acc-4'
    }

    const record = sleepingRecordFromEntry({
      state: createTestStore().getState(),
      entry,
      worktreeId: 'w1',
      tab,
      capturedAt: 1000,
      origin: 'worktree-sleep'
    })

    expect(record?.launchAccountId).toBe('acc-4')
  })
})
