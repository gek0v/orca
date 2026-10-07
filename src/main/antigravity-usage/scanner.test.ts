import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanAntigravityUsageFiles } from './scanner'

describe('scanAntigravityUsageFiles', () => {
  const testRoot = join(process.cwd(), 'scratch-scanner-test')
  const repoRoot = join(process.cwd(), 'scratch-scanner-repo')

  beforeEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true })
      rmSync(repoRoot, { recursive: true, force: true })
    } catch {
      // ignore
    }
    mkdirSync(testRoot, { recursive: true })
    mkdirSync(repoRoot, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true })
      rmSync(repoRoot, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('scans transcripts and aggregates usage by worktree and date', async () => {
    const convId = 'session-scan-1'
    const logsDir = join(testRoot, 'brain', convId, '.system_generated', 'logs')
    mkdirSync(logsDir, { recursive: true })

    const lines = [
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        created_at: '2026-10-05T12:00:00.000Z',
        model: 'gemini-2.5-flash',
        input_tokens: 1500,
        cache_read_tokens: 300,
        output_tokens: 400
      }),
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        created_at: '2026-10-05T12:05:00.000Z',
        model: 'gemini-2.5-flash',
        input_tokens: 2000,
        cache_read_tokens: 500,
        output_tokens: 600
      })
    ]
    writeFileSync(join(logsDir, 'transcript.jsonl'), lines.join('\n'))

    writeFileSync(
      join(testRoot, 'history.jsonl'),
      JSON.stringify({ conversationId: convId, workspace: repoRoot })
    )

    const worktrees = [
      {
        worktreeId: 'wt-orca-test',
        repoId: 'repo-orca-test',
        path: repoRoot,
        displayName: 'Orca Test Repo'
      }
    ]

    const result = await scanAntigravityUsageFiles(worktrees, [], {
      customRootDirs: [testRoot]
    })

    expect(result.processedFiles).toHaveLength(1)
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]?.sessionId).toBe(convId)
    expect(result.sessions[0]?.totalInputTokens).toBe(3500)
    expect(result.sessions[0]?.totalCachedInputTokens).toBe(800)
    expect(result.sessions[0]?.totalOutputTokens).toBe(1000)
    expect(result.sessions[0]?.totalTokens).toBe(4500)
    expect(result.sessions[0]?.primaryWorktreeId).toBe('wt-orca-test')

    expect(result.dailyAggregates).toHaveLength(1)
    expect(result.dailyAggregates[0]?.day).toBe('2026-10-05')
    expect(result.dailyAggregates[0]?.totalTokens).toBe(4500)
    expect(result.dailyAggregates[0]?.worktreeId).toBe('wt-orca-test')
  })

  it('reuses processed file stats when mtime and size match', async () => {
    const convId = 'session-scan-cached'
    const logsDir = join(testRoot, 'brain', convId, '.system_generated', 'logs')
    mkdirSync(logsDir, { recursive: true })
    const transcriptFile = join(logsDir, 'transcript.jsonl')
    writeFileSync(
      transcriptFile,
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        created_at: '2026-10-05T12:00:00.000Z',
        input_tokens: 500,
        cache_read_tokens: 0,
        output_tokens: 100
      })
    )

    const firstRun = await scanAntigravityUsageFiles([], [], {
      customRootDirs: [testRoot]
    })
    expect(firstRun.processedFiles).toHaveLength(1)

    // Second run with previousFiles passed
    const secondRun = await scanAntigravityUsageFiles([], firstRun.processedFiles, {
      customRootDirs: [testRoot]
    })
    expect(secondRun.processedFiles).toHaveLength(1)
    expect(secondRun.processedFiles[0]).toBe(firstRun.processedFiles[0])
  })

  it('does not inflate tool calls or mutate cached aggregates on repeated refresh', async () => {
    const convId = 'session-tool-refresh'
    const logsDir = join(testRoot, 'brain', convId, '.system_generated', 'logs')
    mkdirSync(logsDir, { recursive: true })
    const transcriptFile = join(logsDir, 'transcript.jsonl')
    writeFileSync(
      transcriptFile,
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        created_at: '2026-10-05T12:00:00.000Z',
        tool_calls: [
          { name: 'view_file', args: { AbsolutePath: 'C:/test/file.ts' } },
          { name: 'run_command', args: { CommandLine: 'npm test' } }
        ]
      })
    )

    const scan1 = await scanAntigravityUsageFiles([], [], { customRootDirs: [testRoot] })
    expect(scan1.dailyAggregates[0]?.totalToolCalls).toBe(2)
    expect(scan1.dailyAggregates[0]?.toolCategoryCounts?.read).toBe(1)
    expect(scan1.dailyAggregates[0]?.toolCategoryCounts?.terminal).toBe(1)

    // Repeated scan simulating user clicking refresh
    const scan2 = await scanAntigravityUsageFiles([], scan1.processedFiles, {
      customRootDirs: [testRoot]
    })
    expect(scan2.dailyAggregates[0]?.totalToolCalls).toBe(2)
    expect(scan2.dailyAggregates[0]?.toolCategoryCounts?.read).toBe(1)
    expect(scan2.dailyAggregates[0]?.toolCategoryCounts?.terminal).toBe(1)

    // Third scan
    const scan3 = await scanAntigravityUsageFiles([], scan2.processedFiles, {
      customRootDirs: [testRoot]
    })
    expect(scan3.dailyAggregates[0]?.totalToolCalls).toBe(2)
    expect(scan3.dailyAggregates[0]?.toolCategoryCounts?.read).toBe(1)
    expect(scan3.dailyAggregates[0]?.toolCategoryCounts?.terminal).toBe(1)
  })
})
