import { highestUsageKey } from '../usage/highest-usage-key'
import type {
  AntigravityFileActivityRow,
  AntigravityToolBreakdownRow,
  AntigravityToolCategory,
  AntigravityUsageBreakdownKind,
  AntigravityUsageBreakdownRow,
  AntigravityUsageDailyPoint,
  AntigravityUsageRange,
  AntigravityUsageScope,
  AntigravityUsageSessionRow,
  AntigravityUsageSummary
} from '../../shared/antigravity-usage-types'
import type { AntigravityUsageDailyAggregate, AntigravityUsageSession } from './types'

type TokenTotals = Pick<
  AntigravityUsageDailyPoint,
  'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'reasoningOutputTokens' | 'totalTokens'
>

function emptyTotals(): TokenTotals {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  }
}

function addTotals(target: TokenTotals, row: AntigravityUsageDailyAggregate): void {
  target.inputTokens += row.inputTokens
  target.cachedInputTokens += row.cachedInputTokens
  target.outputTokens += row.outputTokens
  target.reasoningOutputTokens += row.reasoningOutputTokens
  target.totalTokens += row.totalTokens
}

function addCost(left: number | null, right: number | null): number | null {
  if (left === null && right === null) {
    return null
  }
  return (left ?? 0) + (right ?? 0)
}

export const ANTIGRAVITY_TOOL_CATEGORIES: readonly AntigravityToolCategory[] = [
  'terminal',
  'edit',
  'read',
  'search',
  'subagent',
  'other'
] as const

export const ANTIGRAVITY_TOOL_CATEGORY_LABELS: Record<AntigravityToolCategory, string> = {
  terminal: 'Terminal commands',
  edit: 'File modifications',
  read: 'File reads',
  search: 'Web & doc searches',
  subagent: 'Subagents & delegation',
  other: 'Other tools'
}

export function emptyAntigravityToolCategoryCounts(): Record<AntigravityToolCategory, number> {
  return {
    terminal: 0,
    edit: 0,
    read: 0,
    search: 0,
    subagent: 0,
    other: 0
  }
}

export function buildAntigravityUsageSummary(
  scope: AntigravityUsageScope,
  range: AntigravityUsageRange,
  filteredDaily: AntigravityUsageDailyAggregate[],
  filteredSessions: AntigravityUsageSession[]
): AntigravityUsageSummary {
  const totals = emptyTotals()
  let turns = 0
  let estimatedCostUsd: number | null = null
  let totalToolCalls = 0
  const toolCategoryCounts = emptyAntigravityToolCategoryCounts()
  const uniqueFiles = new Set<string>()
  const byModel = new Map<string, number>()
  const byProject = new Map<string, number>()

  for (const row of filteredDaily) {
    addTotals(totals, row)
    turns += row.eventCount
    estimatedCostUsd = addCost(estimatedCostUsd, row.estimatedCostUsd)
    const model = row.model ?? 'Gemini Flash'
    byModel.set(model, (byModel.get(model) ?? 0) + row.totalTokens)
    byProject.set(row.projectLabel, (byProject.get(row.projectLabel) ?? 0) + row.totalTokens)

    if (row.totalToolCalls) {
      totalToolCalls += row.totalToolCalls
    }
    if (row.toolCategoryCounts) {
      for (const cat of ANTIGRAVITY_TOOL_CATEGORIES) {
        toolCategoryCounts[cat] += row.toolCategoryCounts[cat] ?? 0
      }
    }
  }

  for (const session of filteredSessions) {
    if (session.filesTouched) {
      for (const filePath of Object.keys(session.filesTouched)) {
        uniqueFiles.add(filePath)
      }
    }
  }

  return {
    scope,
    range,
    sessions: filteredSessions.length,
    turns,
    ...totals,
    estimatedCostUsd:
      estimatedCostUsd !== null ? Math.round(estimatedCostUsd * 100) / 100 : null,
    topModel: highestUsageKey(byModel),
    topProject: highestUsageKey(byProject),
    hasAnyAntigravityData: filteredSessions.length > 0 || filteredDaily.length > 0,
    totalToolCalls,
    toolCategoryCounts,
    totalFilesTouched: uniqueFiles.size,
    toolBreakdown: buildAntigravityToolBreakdown(filteredDaily),
    topFiles: buildAntigravityTopFiles(filteredSessions)
  }
}

export function buildAntigravityUsageDailyPoints(
  filteredDaily: AntigravityUsageDailyAggregate[]
): AntigravityUsageDailyPoint[] {
  const byDay = new Map<string, AntigravityUsageDailyPoint>()
  for (const row of filteredDaily) {
    const existing = byDay.get(row.day) ?? { day: row.day, ...emptyTotals() }
    addTotals(existing, row)
    byDay.set(row.day, existing)
  }
  return [...byDay.values()].sort((left, right) => left.day.localeCompare(right.day))
}

export function buildAntigravityUsageBreakdownRows(
  kind: AntigravityUsageBreakdownKind,
  scope: AntigravityUsageScope,
  filteredDaily: AntigravityUsageDailyAggregate[],
  filteredSessions: AntigravityUsageSession[]
): AntigravityUsageBreakdownRow[] {
  const rows = new Map<
    string,
    AntigravityUsageBreakdownRow & { rawCost: number | null }
  >()

  for (const daily of filteredDaily) {
    const key = kind === 'model' ? (daily.model ?? 'unknown') : daily.projectKey
    const label = kind === 'model' ? (daily.model ?? 'Gemini Flash') : daily.projectLabel
    const existing = rows.get(key) ?? {
      key,
      label,
      sessions: 0,
      turns: 0,
      rawCost: null,
      estimatedCostUsd: null,
      totalToolCalls: 0,
      toolCategoryCounts: emptyAntigravityToolCategoryCounts(),
      ...emptyTotals()
    }
    existing.turns += daily.eventCount
    existing.rawCost = addCost(existing.rawCost, daily.estimatedCostUsd)
    if (daily.totalToolCalls) {
      existing.totalToolCalls = (existing.totalToolCalls ?? 0) + daily.totalToolCalls
    }
    if (daily.toolCategoryCounts) {
      if (!existing.toolCategoryCounts) {
        existing.toolCategoryCounts = emptyAntigravityToolCategoryCounts()
      }
      for (const cat of ANTIGRAVITY_TOOL_CATEGORIES) {
        existing.toolCategoryCounts[cat] =
          (existing.toolCategoryCounts[cat] ?? 0) + (daily.toolCategoryCounts[cat] ?? 0)
      }
    }
    addTotals(existing, daily)
    rows.set(key, existing)
  }

  for (const session of filteredSessions) {
    const keys =
      kind === 'model'
        ? session.locationModelBreakdown
            .filter((entry) => scope === 'all' || entry.worktreeId !== null)
            .map((entry) => entry.modelKey)
        : session.locationBreakdown
            .filter((entry) => scope === 'all' || entry.worktreeId !== null)
            .map((entry) => entry.locationKey)

    for (const key of new Set(keys)) {
      const row = rows.get(key)
      if (row) {
        row.sessions++
      }
    }
  }

  return [...rows.values()]
    .map((row) => ({
      key: row.key,
      label: row.label,
      sessions: row.sessions,
      turns: row.turns,
      inputTokens: row.inputTokens,
      cachedInputTokens: row.cachedInputTokens,
      outputTokens: row.outputTokens,
      reasoningOutputTokens: row.reasoningOutputTokens,
      totalTokens: row.totalTokens,
      estimatedCostUsd: row.rawCost !== null ? Math.round(row.rawCost * 100) / 100 : null,
      totalToolCalls: row.totalToolCalls,
      toolCategoryCounts: row.toolCategoryCounts
    }))
    .sort((left, right) => right.totalTokens - left.totalTokens)
}

export function buildAntigravityToolBreakdown(
  filteredDaily: AntigravityUsageDailyAggregate[]
): AntigravityToolBreakdownRow[] {
  const counts = emptyAntigravityToolCategoryCounts()
  let total = 0

  for (const row of filteredDaily) {
    if (row.toolCategoryCounts) {
      for (const cat of ANTIGRAVITY_TOOL_CATEGORIES) {
        const val = row.toolCategoryCounts[cat] ?? 0
        counts[cat] += val
        total += val
      }
    }
  }

  return ANTIGRAVITY_TOOL_CATEGORIES.map((category) => {
    const count = counts[category]
    const percentage = total > 0 ? Math.round((count / total) * 1000) / 10 : 0
    return {
      category,
      label: ANTIGRAVITY_TOOL_CATEGORY_LABELS[category],
      count,
      percentage
    }
  })
}

export function buildAntigravityTopFiles(
  filteredSessions: AntigravityUsageSession[],
  limit = 20
): AntigravityFileActivityRow[] {
  const byPath = new Map<string, { reads: number; edits: number }>()

  for (const session of filteredSessions) {
    if (!session.filesTouched) {
      continue
    }
    for (const [filePath, stat] of Object.entries(session.filesTouched)) {
      const existing = byPath.get(filePath) ?? { reads: 0, edits: 0 }
      existing.reads += stat.reads
      existing.edits += stat.edits
      byPath.set(filePath, existing)
    }
  }

  return [...byPath.entries()]
    .map(([path, stat]) => ({
      path,
      reads: stat.reads,
      edits: stat.edits,
      totalActions: stat.reads + stat.edits
    }))
    .sort((a, b) => {
      if (b.totalActions !== a.totalActions) {
        return b.totalActions - a.totalActions
      }
      return a.path.localeCompare(b.path)
    })
    .slice(0, limit)
}

export function buildAntigravityUsageRecentSessions(
  filteredSessions: AntigravityUsageSession[],
  limit = 10
): AntigravityUsageSessionRow[] {
  return filteredSessions.slice(0, limit).map((session) => ({
    sessionId: session.sessionId,
    lastActiveAt: session.lastTimestamp,
    durationMinutes: Math.max(
      0,
      Math.round(
        (new Date(session.lastTimestamp).getTime() - new Date(session.firstTimestamp).getTime()) /
          60_000
      )
    ),
    projectLabel: session.primaryProjectLabel,
    model: session.primaryModel,
    turns: session.eventCount,
    inputTokens: session.totalInputTokens,
    cachedInputTokens: session.totalCachedInputTokens,
    outputTokens: session.totalOutputTokens,
    reasoningOutputTokens: session.totalReasoningOutputTokens,
    totalTokens: session.totalTokens,
    toolCalls: session.totalToolCalls ?? 0
  }))
}

