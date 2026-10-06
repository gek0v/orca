import { stat } from 'node:fs/promises'
import { yieldToEventLoop } from '../../shared/event-loop-yield'
import { attributeUsageEvent } from '../usage/usage-event-attribution'
import { createUsageEventAggregation } from '../usage/usage-event-aggregation'
import { readJsonlLinesFromOffset } from '../usage/jsonl-line-offsets'
import type { UsageScanWorktreeRef } from '../usage/usage-provider-contract'
import {
  createUsageWorktreeResolver,
  type UsageWorktreeResolver
} from '../usage/usage-worktree-resolver'
import {
  discoverAntigravitySessions,
  type AntigravityDiscoveryOptions,
  type AntigravitySessionMetadata
} from './antigravity-session-discovery'
import {
  parseAntigravityTranscriptLine,
  type AntigravityTranscriptContext
} from './antigravity-usage-record-parser'
import {
  ANTIGRAVITY_TOOL_CATEGORIES,
  emptyAntigravityToolCategoryCounts
} from './snapshot-rollups'
import type {
  AntigravityUsageAttributedEvent,
  AntigravityUsageDailyAggregate,
  AntigravityUsageMetric,
  AntigravityUsagePersistedFile,
  AntigravityUsageSession
} from './types'

const YIELD_EVERY_FILES = 10

function addCost(left: number | null, right: number | null): number | null {
  if (left === null && right === null) {
    return null
  }
  return (left ?? 0) + (right ?? 0)
}

export const antigravityUsageAggregation = createUsageEventAggregation<
  AntigravityUsageAttributedEvent,
  AntigravityUsageMetric
>({
  metric: {
    empty: () => ({
      estimatedCostUsd: null,
      totalToolCalls: 0,
      toolCategoryCounts: emptyAntigravityToolCategoryCounts(),
      filesTouched: {}
    }),
    fromEvent: (event) => {
      const toolCategoryCounts = emptyAntigravityToolCategoryCounts()
      const filesTouched: Record<string, { reads: number; edits: number }> = {}

      for (const call of event.toolCalls) {
        toolCategoryCounts[call.category] = (toolCategoryCounts[call.category] ?? 0) + 1
        if (call.targetFile) {
          const existing = filesTouched[call.targetFile] ?? { reads: 0, edits: 0 }
          if (call.isRead) {
            existing.reads++
          }
          if (call.isEdit) {
            existing.edits++
          }
          filesTouched[call.targetFile] = existing
        }
      }

      return {
        estimatedCostUsd: event.estimatedCostUsd,
        totalToolCalls: event.toolCalls.length,
        toolCategoryCounts,
        filesTouched
      }
    },
    fold: (target, source) => {
      target.estimatedCostUsd = addCost(target.estimatedCostUsd, source.estimatedCostUsd)
      target.totalToolCalls = (target.totalToolCalls ?? 0) + (source.totalToolCalls ?? 0)
      if (source.toolCategoryCounts) {
        const nextCounts = emptyAntigravityToolCategoryCounts()
        for (const cat of ANTIGRAVITY_TOOL_CATEGORIES) {
          nextCounts[cat] =
            (target.toolCategoryCounts?.[cat] ?? 0) + (source.toolCategoryCounts[cat] ?? 0)
        }
        target.toolCategoryCounts = nextCounts
      }
      if (source.filesTouched) {
        const nextFiles: Record<string, { reads: number; edits: number }> = {}
        if (target.filesTouched) {
          for (const [path, stat] of Object.entries(target.filesTouched)) {
            nextFiles[path] = { ...stat }
          }
        }
        for (const [path, stat] of Object.entries(source.filesTouched)) {
          const existing = nextFiles[path] ?? { reads: 0, edits: 0 }
          nextFiles[path] = {
            reads: existing.reads + stat.reads,
            edits: existing.edits + stat.edits
          }
        }
        target.filesTouched = nextFiles
      }
    }
  },
  cloneSessionForMerge: (session) => ({
    ...session,
    toolCategoryCounts: { ...session.toolCategoryCounts },
    filesTouched: Object.fromEntries(
      Object.entries(session.filesTouched ?? {}).map(([k, v]) => [k, { ...v }])
    ),
    locationBreakdown: session.locationBreakdown.map((entry) => ({ ...entry })),
    modelBreakdown: session.modelBreakdown.map((entry) => ({ ...entry })),
    locationModelBreakdown: session.locationModelBreakdown.map((entry) => ({ ...entry }))
  })
})

const { finalizeSessions, mergeSessions, mergeDailyAggregates, sortDailyAggregates } =
  antigravityUsageAggregation

export async function parseAntigravityUsageFile(
  session: AntigravitySessionMetadata,
  resolveWorktree: UsageWorktreeResolver
): Promise<AntigravityUsagePersistedFile | null> {
  let fileStat
  try {
    fileStat = await stat(session.transcriptPath)
  } catch {
    return null
  }

  const context: AntigravityTranscriptContext = {
    sessionId: session.sessionId,
    cwd: session.cwd,
    model: session.model
  }

  const events: AntigravityUsageAttributedEvent[] = []
  for await (const { line } of readJsonlLinesFromOffset(session.transcriptPath, 0)) {
    const parsed = parseAntigravityTranscriptLine(line, context)
    if (!parsed) {
      continue
    }
    const attributed = attributeUsageEvent(parsed, resolveWorktree)
    if (attributed) {
      events.push(attributed)
    }
  }

  return {
    path: session.transcriptPath,
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    sessionId: session.sessionId,
    ...antigravityUsageAggregation.aggregate(events)
  }
}

export async function scanAntigravityUsageFiles(
  worktrees: UsageScanWorktreeRef[],
  previousFiles: AntigravityUsagePersistedFile[],
  options?: AntigravityDiscoveryOptions & {
    onFilesScanned?: (count: number) => void
  }
): Promise<{
  processedFiles: AntigravityUsagePersistedFile[]
  sessions: AntigravityUsageSession[]
  dailyAggregates: AntigravityUsageDailyAggregate[]
}> {
  const discoveredSessions = discoverAntigravitySessions(options)
  const previousByPath = new Map(previousFiles.map((file) => [file.path, file]))
  const resolveWorktree = await createUsageWorktreeResolver(worktrees)

  const processedFiles: AntigravityUsagePersistedFile[] = []
  const sessionsById = new Map<string, AntigravityUsageSession>()
  const dailyByKey = new Map<string, AntigravityUsageDailyAggregate>()

  for (let i = 0; i < discoveredSessions.length; i++) {
    const session = discoveredSessions[i]
    let fileInfo: AntigravityUsagePersistedFile | null = null

    try {
      const fileStat = await stat(session.transcriptPath)
      const previous = previousByPath.get(session.transcriptPath)
      fileInfo =
        previous &&
        previous.mtimeMs === fileStat.mtimeMs &&
        previous.size === fileStat.size
          ? previous
          : await parseAntigravityUsageFile(session, resolveWorktree)
    } catch {
      continue
    }

    if (fileInfo) {
      processedFiles.push(fileInfo)
      mergeSessions(sessionsById, fileInfo.sessions)
      const clonedAggregates = fileInfo.dailyAggregates.map((da) => ({
        ...da,
        toolCategoryCounts: da.toolCategoryCounts
          ? { ...da.toolCategoryCounts }
          : emptyAntigravityToolCategoryCounts(),
        filesTouched: da.filesTouched
          ? Object.fromEntries(Object.entries(da.filesTouched).map(([k, v]) => [k, { ...v }]))
          : {}
      }))
      mergeDailyAggregates(dailyByKey, clonedAggregates)
    }

    options?.onFilesScanned?.(1)
    if ((i + 1) % YIELD_EVERY_FILES === 0) {
      await yieldToEventLoop()
    }
  }

  return {
    processedFiles,
    sessions: finalizeSessions(sessionsById),
    dailyAggregates: sortDailyAggregates(dailyByKey)
  }
}
