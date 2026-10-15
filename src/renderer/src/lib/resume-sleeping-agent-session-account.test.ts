import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppStoreState, true)
})

function makeRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'antigravity',
    providerSession: { key: 'conversation_id', id: 'conv-1' },
    prompt: 'finish the task',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('resumeSleepingAgentSessionsForWorktree account binding', () => {
  it('forwards launchAccountId from sleeping record to resumed tab', () => {
    const record = makeRecord({
      agent: 'antigravity',
      providerSession: { key: 'conversation_id', id: 'conv-1' },
      launchAccountId: 'account-alpha',
      origin: 'worktree-sleep'
    })
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    })

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(1)
    const state = useAppStore.getState()
    const resumedTab = state.tabsByWorktree['wt-1']?.[0]
    expect(resumedTab?.launchAgent).toBe('antigravity')
    expect(resumedTab?.launchAccountId).toBe('account-alpha')
  })
})
