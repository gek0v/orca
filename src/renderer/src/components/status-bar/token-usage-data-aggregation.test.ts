import { describe, expect, it } from 'vitest'
import {
  aggregateProjectMetrics,
  aggregateRecentSessions,
  extractActiveProjectName
} from './token-usage-data-aggregation'

describe('token-usage-data-aggregation', () => {
  it('extractActiveProjectName resolves active project name', () => {
    const worktreesByRepo = {
      repo1: [
        { id: 'wt-1', name: 'Project Alpha', path: '/path/to/alpha' },
        { id: 'wt-2', path: '/path/to/beta' }
      ]
    }
    expect(extractActiveProjectName('wt-1', worktreesByRepo)).toBe('Project Alpha')
    expect(extractActiveProjectName('wt-2', worktreesByRepo)).toBe('beta')
    expect(extractActiveProjectName('nonexistent', worktreesByRepo)).toBeNull()
    expect(extractActiveProjectName(null, worktreesByRepo)).toBeNull()
  })

  it('aggregateProjectMetrics separates and filters tool calls per project', () => {
    const breakdowns = {
      claude: [{ key: 'proj-alpha', label: 'Project Alpha', inputTokens: 1000, outputTokens: 500 }],
      codex: [],
      opencode: [],
      muse: [],
      antigravity: [
        {
          key: 'proj-alpha',
          label: 'Project Alpha',
          inputTokens: 2000,
          outputTokens: 1000,
          totalToolCalls: 5,
          toolCategoryCounts: {
            read: 3,
            edit: 2,
            terminal: 0,
            search: 0,
            subagent: 0,
            other: 0
          }
        },
        {
          key: 'proj-beta',
          label: 'Project Beta',
          inputTokens: 4000,
          outputTokens: 2000,
          totalToolCalls: 8,
          toolCategoryCounts: {
            read: 2,
            edit: 1,
            terminal: 5,
            search: 0,
            subagent: 0,
            other: 0
          }
        }
      ]
    }

    // 1. Project Alpha filter
    const alphaMetrics = aggregateProjectMetrics('Project Alpha', breakdowns)
    expect(alphaMetrics.name).toBe('Project Alpha')
    expect(alphaMetrics.totalTokens).toBe(4500)
    expect(alphaMetrics.toolCalls).toBe(5)
    expect(alphaMetrics.toolCategoryCounts.read).toBe(3)
    expect(alphaMetrics.toolCategoryCounts.edit).toBe(2)
    expect(alphaMetrics.toolCategoryCounts.terminal).toBe(0)

    // 2. Project Beta filter
    const betaMetrics = aggregateProjectMetrics('Project Beta', breakdowns)
    expect(betaMetrics.name).toBe('Project Beta')
    expect(betaMetrics.totalTokens).toBe(6000)
    expect(betaMetrics.toolCalls).toBe(8)
    expect(betaMetrics.toolCategoryCounts.terminal).toBe(5)
    expect(betaMetrics.toolCategoryCounts.read).toBe(2)
    expect(betaMetrics.toolCategoryCounts.edit).toBe(1)

    // 3. Project Gamma (no usage)
    const gammaMetrics = aggregateProjectMetrics('Project Gamma', breakdowns)
    expect(gammaMetrics.name).toBe('Project Gamma')
    expect(gammaMetrics.totalTokens).toBe(0)
    expect(gammaMetrics.toolCalls).toBe(0)
    expect(gammaMetrics.toolCategoryCounts.read).toBe(0)

    // 4. Global (null project)
    const globalMetrics = aggregateProjectMetrics(null, breakdowns)
    expect(globalMetrics.name).toBe('Global')
    expect(globalMetrics.totalTokens).toBe(10500)
    expect(globalMetrics.toolCalls).toBe(13)
    expect(globalMetrics.toolCategoryCounts.read).toBe(5)
    expect(globalMetrics.toolCategoryCounts.edit).toBe(3)
    expect(globalMetrics.toolCategoryCounts.terminal).toBe(5)
  })

  it('aggregateRecentSessions parses tool calls and filters by project', () => {
    const sessions = {
      claude: [],
      codex: [],
      opencode: [],
      muse: [],
      antigravity: [
        {
          sessionId: 's1',
          lastActiveAt: '2026-10-06T10:00:00.000Z',
          projectLabel: 'Project Alpha',
          model: 'Gemini Flash',
          turns: 2,
          inputTokens: 100,
          outputTokens: 50,
          toolCalls: 4
        },
        {
          sessionId: 's2',
          lastActiveAt: '2026-10-06T09:00:00.000Z',
          projectLabel: 'Project Beta',
          model: 'Gemini Pro',
          turns: 3,
          inputTokens: 200,
          outputTokens: 100,
          toolCalls: 7
        }
      ]
    }

    const alphaRecent = aggregateRecentSessions(sessions, 'Project Alpha')
    expect(alphaRecent).toHaveLength(1)
    expect(alphaRecent[0]?.sessionId).toBe('s1')
    expect(alphaRecent[0]?.toolCalls).toBe(4)
    expect(alphaRecent[0]?.provider).toBe('Antigravity')

    const allRecent = aggregateRecentSessions(sessions, null)
    expect(allRecent).toHaveLength(2)
    expect(allRecent[0]?.sessionId).toBe('s1')
    expect(allRecent[1]?.sessionId).toBe('s2')
  })
})
