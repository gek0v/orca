import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AntigravityUsagePersistedState } from './types'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn(() => '/tmp/orca-test-userdata')
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

import { ANTIGRAVITY_USAGE_SCHEMA_VERSION } from './persisted-state-normalization'
import { AntigravityUsageStore, initAntigravityUsagePath } from './store'

function createBackingStore(): ConstructorParameters<typeof AntigravityUsageStore>[0] {
  return {
    getRepos: () => [],
    getAllWorktreeMeta: () => ({})
  }
}

function createStoreWithState(
  state: Partial<AntigravityUsagePersistedState>
): AntigravityUsageStore {
  const store = new AntigravityUsageStore(createBackingStore())

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test helper assigns mock state directly.
  ;(store as unknown as { state: AntigravityUsagePersistedState }).state = {
    schemaVersion: 1,
    worktreeFingerprint: null,
    processedFiles: [],
    sessions: [],
    dailyAggregates: [],
    scanState: {
      enabled: false,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null
    },
    ...state
  }

  return store
}

describe('AntigravityUsageStore', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-agy-store-test-'))
    getPathMock.mockReturnValue(tempDir)
    initAntigravityUsagePath()
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
    vi.restoreAllMocks()
  })

  it('returns an empty snapshot when initialized with default state', () => {
    const store = new AntigravityUsageStore(createBackingStore())
    const snapshot = store.getSnapshot('all', 'all')

    expect(snapshot.summary.totalTokens).toBe(0)
    expect(snapshot.summary.sessions).toBe(0)
    expect(snapshot.summary.hasAnyAntigravityData).toBe(false)
    expect(snapshot.daily).toEqual([])
    expect(snapshot.modelBreakdown).toEqual([])
    expect(snapshot.projectBreakdown).toEqual([])
    expect(snapshot.recentSessions).toEqual([])
  })

  const mockMetric = {
    totalToolCalls: 0,
    toolCategoryCounts: {
      terminal: 0,
      edit: 0,
      read: 0,
      search: 0,
      subagent: 0,
      other: 0
    },
    filesTouched: {}
  }

  it('filters data by scope and range in getSnapshot', () => {
    const store = createStoreWithState({
      dailyAggregates: [
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
          ...mockMetric
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
          ...mockMetric
        }
      ],
      sessions: [
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
          ...mockMetric,
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
              ...mockMetric
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
              ...mockMetric
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
              ...mockMetric
            }
          ]
        }
      ]
    })

    const allSnapshot = store.getSnapshot('all', 'all')
    expect(allSnapshot.summary.totalTokens).toBe(4500)
    expect(allSnapshot.summary.hasAnyAntigravityData).toBe(true)

    const orcaOnlySnapshot = store.getSnapshot('orca', 'all')
    expect(orcaOnlySnapshot.summary.totalTokens).toBe(1500)
  })

  it('loads and normalizes existing state on disk', () => {
    const cacheFile = join(tempDir, 'orca-antigravity-usage.json')
    writeFileSync(
      cacheFile,
      JSON.stringify({
        schemaVersion: ANTIGRAVITY_USAGE_SCHEMA_VERSION,
        processedFiles: [],
        sessions: [],
        dailyAggregates: [],
        scanState: {
          enabled: true,
          lastScanStartedAt: 1234,
          lastScanCompletedAt: 5678,
          lastScanError: null
        }
      })
    )

    const store = new AntigravityUsageStore(createBackingStore())
    const scanState = store.getScanState()
    expect(scanState.enabled).toBe(true)
    expect(scanState.lastScanCompletedAt).toBe(5678)

    const snapshot = store.getSnapshot('all', 'all')
    expect(snapshot.toolBreakdown).toBeDefined()
    expect(snapshot.topFiles).toBeDefined()
  })
})
