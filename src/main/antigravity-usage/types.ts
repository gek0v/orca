import type { AntigravityToolCategory } from '../../shared/antigravity-usage-types'
import type {
  UsageDailyAggregate,
  UsageLocationBreakdown,
  UsageLocationModelBreakdown,
  UsageModelBreakdown,
  UsageSession
} from '../usage/usage-rollup-records'

export type AntigravityUsageFileStat = {
  reads: number
  edits: number
}

export type AntigravityUsageMetric = {
  estimatedCostUsd: number | null
  totalToolCalls: number
  toolCategoryCounts: Record<AntigravityToolCategory, number>
  filesTouched: Record<string, AntigravityUsageFileStat>
}

export type AntigravityUsageLocationBreakdown = UsageLocationBreakdown<AntigravityUsageMetric>
export type AntigravityUsageModelBreakdown = UsageModelBreakdown<AntigravityUsageMetric>
export type AntigravityUsageLocationModelBreakdown =
  UsageLocationModelBreakdown<AntigravityUsageMetric>
export type AntigravityUsageSession = UsageSession<AntigravityUsageMetric>
export type AntigravityUsageDailyAggregate = UsageDailyAggregate<AntigravityUsageMetric>

export type AntigravityUsageProcessedFile = {
  path: string
  mtimeMs: number
  size: number
}

export type AntigravityUsagePersistedFile = AntigravityUsageProcessedFile & {
  sessionId: string
  sessions: AntigravityUsageSession[]
  dailyAggregates: AntigravityUsageDailyAggregate[]
}

export type AntigravityUsagePersistedState = {
  schemaVersion: number
  worktreeFingerprint: string | null
  processedFiles: AntigravityUsagePersistedFile[]
  sessions: AntigravityUsageSession[]
  dailyAggregates: AntigravityUsageDailyAggregate[]
  scanState: {
    enabled: boolean
    lastScanStartedAt: number | null
    lastScanCompletedAt: number | null
    lastScanError: string | null
  }
}

export type AntigravityUsageParsedToolCall = {
  category: AntigravityToolCategory
  toolName: string
  targetFile?: string | null
  isEdit?: boolean
  isRead?: boolean
}

export type AntigravityUsageParsedEvent = {
  sessionId: string
  timestamp: string
  model: string | null
  cwd: string | null
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
  estimatedCostUsd: number | null
  toolCalls: AntigravityUsageParsedToolCall[]
}

export type AntigravityUsageAttributedEvent = AntigravityUsageParsedEvent & {
  day: string
  projectKey: string
  projectLabel: string
  repoId: string | null
  worktreeId: string | null
}
