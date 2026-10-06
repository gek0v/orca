import { describe, expect, it } from 'vitest'
import {
  buildAntigravityToolBreakdown,
  buildAntigravityTopFiles,
  buildAntigravityUsageBreakdownRows,
  buildAntigravityUsageDailyPoints,
  buildAntigravityUsageRecentSessions,
  buildAntigravityUsageSummary
} from './snapshot-rollups'
import type { AntigravityUsageDailyAggregate, AntigravityUsageSession } from './types'

describe('snapshot-rollups', () => {
  const sampleDaily: AntigravityUsageDailyAggregate[] = [
    {
      day: '2026-10-04',
      model: 'Gemini 2.5 Flash',
      projectKey: 'proj-1',
      projectLabel: 'Project 1',
      repoId: 'repo-1',
      worktreeId: 'wt-1',
      eventCount: 3,
      inputTokens: 1000,
      cachedInputTokens: 200,
      outputTokens: 500,
      reasoningOutputTokens: 100,
      totalTokens: 1500,
      estimatedCostUsd: 0.0002,
      totalToolCalls: 4,
      toolCategoryCounts: {
        terminal: 2,
        edit: 1,
        read: 1,
        search: 0,
        subagent: 0,
        other: 0
      },
      filesTouched: {
        'src/main.ts': { reads: 1, edits: 1 }
      }
    },
    {
      day: '2026-10-05',
      model: 'Gemini 2.5 Pro',
      projectKey: 'proj-2',
      projectLabel: 'Project 2',
      repoId: null,
      worktreeId: null,
      eventCount: 2,
      inputTokens: 2000,
      cachedInputTokens: 500,
      outputTokens: 1000,
      reasoningOutputTokens: 200,
      totalTokens: 3000,
      estimatedCostUsd: 0.007,
      totalToolCalls: 6,
      toolCategoryCounts: {
        terminal: 1,
        edit: 2,
        read: 2,
        search: 1,
        subagent: 0,
        other: 0
      },
      filesTouched: {
        'src/main.ts': { reads: 1, edits: 0 },
        'src/renderer.tsx': { reads: 1, edits: 2 }
      }
    }
  ]

  const sampleSessions: AntigravityUsageSession[] = [
    {
      sessionId: 'sess-1',
      firstTimestamp: '2026-10-05T10:00:00.000Z',
      lastTimestamp: '2026-10-05T10:30:00.000Z',
      primaryModel: 'Gemini 2.5 Pro',
      hasMixedModels: false,
      primaryProjectLabel: 'Project 2',
      hasMixedLocations: false,
      primaryWorktreeId: null,
      primaryRepoId: null,
      eventCount: 2,
      totalInputTokens: 2000,
      totalCachedInputTokens: 500,
      totalOutputTokens: 1000,
      totalReasoningOutputTokens: 200,
      totalTokens: 3000,
      estimatedCostUsd: 0.007,
      totalToolCalls: 6,
      toolCategoryCounts: {
        terminal: 1,
        edit: 2,
        read: 2,
        search: 1,
        subagent: 0,
        other: 0
      },
      filesTouched: {
        'src/main.ts': { reads: 1, edits: 0 },
        'src/renderer.tsx': { reads: 1, edits: 2 }
      },
      locationBreakdown: [
        {
          locationKey: 'proj-2',
          projectLabel: 'Project 2',
          repoId: null,
          worktreeId: null,
          eventCount: 2,
          inputTokens: 2000,
          cachedInputTokens: 500,
          outputTokens: 1000,
          reasoningOutputTokens: 200,
          totalTokens: 3000,
          estimatedCostUsd: 0.007,
          totalToolCalls: 6,
          toolCategoryCounts: {
            terminal: 1,
            edit: 2,
            read: 2,
            search: 1,
            subagent: 0,
            other: 0
          },
          filesTouched: {
            'src/main.ts': { reads: 1, edits: 0 },
            'src/renderer.tsx': { reads: 1, edits: 2 }
          }
        }
      ],
      modelBreakdown: [
        {
          modelKey: 'Gemini 2.5 Pro',
          modelLabel: 'Gemini 2.5 Pro',
          eventCount: 2,
          inputTokens: 2000,
          cachedInputTokens: 500,
          outputTokens: 1000,
          reasoningOutputTokens: 200,
          totalTokens: 3000,
          estimatedCostUsd: 0.007,
          totalToolCalls: 6,
          toolCategoryCounts: {
            terminal: 1,
            edit: 2,
            read: 2,
            search: 1,
            subagent: 0,
            other: 0
          },
          filesTouched: {
            'src/main.ts': { reads: 1, edits: 0 },
            'src/renderer.tsx': { reads: 1, edits: 2 }
          }
        }
      ],
      locationModelBreakdown: [
        {
          locationKey: 'proj-2',
          modelKey: 'Gemini 2.5 Pro',
          modelLabel: 'Gemini 2.5 Pro',
          repoId: null,
          worktreeId: null,
          eventCount: 2,
          inputTokens: 2000,
          cachedInputTokens: 500,
          outputTokens: 1000,
          reasoningOutputTokens: 200,
          totalTokens: 3000,
          estimatedCostUsd: 0.007,
          totalToolCalls: 6,
          toolCategoryCounts: {
            terminal: 1,
            edit: 2,
            read: 2,
            search: 1,
            subagent: 0,
            other: 0
          },
          filesTouched: {
            'src/main.ts': { reads: 1, edits: 0 },
            'src/renderer.tsx': { reads: 1, edits: 2 }
          }
        }
      ]
    }
  ]

  it('buildAntigravityUsageSummary computes totals, turns, cost, toolCalls, and filesTouched', () => {
    const summary = buildAntigravityUsageSummary('all', 'all', sampleDaily, sampleSessions)
    expect(summary.scope).toBe('all')
    expect(summary.range).toBe('all')
    expect(summary.sessions).toBe(1)
    expect(summary.turns).toBe(5)
    expect(summary.inputTokens).toBe(3000)
    expect(summary.cachedInputTokens).toBe(700)
    expect(summary.outputTokens).toBe(1500)
    expect(summary.reasoningOutputTokens).toBe(300)
    expect(summary.totalTokens).toBe(4500)
    expect(summary.topModel).toBe('Gemini 2.5 Pro')
    expect(summary.topProject).toBe('Project 2')
    expect(summary.hasAnyAntigravityData).toBe(true)
    expect(summary.totalToolCalls).toBe(10)
    expect(summary.toolCategoryCounts.terminal).toBe(3)
    expect(summary.toolCategoryCounts.edit).toBe(3)
    expect(summary.toolCategoryCounts.read).toBe(3)
    expect(summary.toolCategoryCounts.search).toBe(1)
    expect(summary.totalFilesTouched).toBe(2)
  })

  it('buildAntigravityToolBreakdown computes counts and percentages', () => {
    const breakdown = buildAntigravityToolBreakdown(sampleDaily)
    expect(breakdown).toHaveLength(6)
    const terminal = breakdown.find((b) => b.category === 'terminal')
    expect(terminal?.count).toBe(3)
    expect(terminal?.percentage).toBe(30)
    const edit = breakdown.find((b) => b.category === 'edit')
    expect(edit?.count).toBe(3)
    expect(edit?.percentage).toBe(30)
  })

  it('buildAntigravityTopFiles aggregates actions and sorts descending', () => {
    const topFiles = buildAntigravityTopFiles(sampleSessions)
    expect(topFiles).toHaveLength(2)
    expect(topFiles[0]?.path).toBe('src/renderer.tsx')
    expect(topFiles[0]?.reads).toBe(1)
    expect(topFiles[0]?.edits).toBe(2)
    expect(topFiles[0]?.totalActions).toBe(3)
    expect(topFiles[1]?.path).toBe('src/main.ts')
    expect(topFiles[1]?.totalActions).toBe(1)
  })

  it('buildAntigravityUsageDailyPoints groups by day and sorts chronologically', () => {
    const daily = buildAntigravityUsageDailyPoints(sampleDaily)
    expect(daily).toHaveLength(2)
    expect(daily[0]?.day).toBe('2026-10-04')
    expect(daily[0]?.totalTokens).toBe(1500)
    expect(daily[1]?.day).toBe('2026-10-05')
    expect(daily[1]?.totalTokens).toBe(3000)
  })

  it('buildAntigravityUsageBreakdownRows groups by model or project', () => {
    const byModel = buildAntigravityUsageBreakdownRows('model', 'all', sampleDaily, sampleSessions)
    expect(byModel).toHaveLength(2)
    expect(byModel[0]?.key).toBe('Gemini 2.5 Pro')
    expect(byModel[0]?.totalTokens).toBe(3000)
    expect(byModel[0]?.sessions).toBe(1)

    const byProject = buildAntigravityUsageBreakdownRows('project', 'all', sampleDaily, sampleSessions)
    expect(byProject).toHaveLength(2)
    expect(byProject[0]?.key).toBe('proj-2')
    expect(byProject[0]?.sessions).toBe(1)
    expect(byProject[0]?.totalToolCalls).toBe(6)
    expect(byProject[0]?.toolCategoryCounts?.edit).toBe(2)
    expect(byProject[1]?.key).toBe('proj-1')
    expect(byProject[1]?.totalToolCalls).toBe(4)
    expect(byProject[1]?.toolCategoryCounts?.terminal).toBe(2)
  })

  it('buildAntigravityUsageRecentSessions extracts recent session rows with toolCalls', () => {
    const sessions = buildAntigravityUsageRecentSessions(sampleSessions, 5)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.sessionId).toBe('sess-1')
    expect(sessions[0]?.durationMinutes).toBe(30)
    expect(sessions[0]?.model).toBe('Gemini 2.5 Pro')
    expect(sessions[0]?.totalTokens).toBe(3000)
    expect(sessions[0]?.toolCalls).toBe(6)
  })
})
