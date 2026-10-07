export type AntigravityUsageScope = 'orca' | 'all'
export type AntigravityUsageRange = '7d' | '30d' | '90d' | 'all'
export type AntigravityUsageBreakdownKind = 'model' | 'project'

export type AntigravityToolCategory = 'terminal' | 'edit' | 'read' | 'search' | 'subagent' | 'other'

export type AntigravityToolBreakdownRow = {
  category: AntigravityToolCategory
  label: string
  count: number
  percentage: number
}

export type AntigravityFileActivityRow = {
  path: string
  reads: number
  edits: number
  totalActions: number
}

export type AntigravityUsageScanState = {
  enabled: boolean
  isScanning: boolean
  lastScanStartedAt: number | null
  lastScanCompletedAt: number | null
  lastScanError: string | null
  hasAnyAntigravityData: boolean
}

export type AntigravityUsageSummary = {
  scope: AntigravityUsageScope
  range: AntigravityUsageRange
  sessions: number
  turns: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
  estimatedCostUsd: number | null
  topModel: string | null
  topProject: string | null
  hasAnyAntigravityData: boolean
  totalToolCalls: number
  toolCategoryCounts: Record<AntigravityToolCategory, number>
  totalFilesTouched: number
  toolBreakdown: AntigravityToolBreakdownRow[]
  topFiles: AntigravityFileActivityRow[]
}

export type AntigravityUsageDailyPoint = {
  day: string
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export type AntigravityUsageBreakdownRow = {
  key: string
  label: string
  sessions: number
  turns: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
  estimatedCostUsd: number | null
  totalToolCalls?: number
  toolCategoryCounts?: Record<AntigravityToolCategory, number>
}

export type AntigravityUsageSessionRow = {
  sessionId: string
  lastActiveAt: string
  durationMinutes: number
  projectLabel: string
  model: string | null
  turns: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
  toolCalls?: number
}

export type AntigravityUsageSnapshot = {
  scanState: AntigravityUsageScanState
  summary: AntigravityUsageSummary
  daily: AntigravityUsageDailyPoint[]
  modelBreakdown: AntigravityUsageBreakdownRow[]
  projectBreakdown: AntigravityUsageBreakdownRow[]
  toolBreakdown: AntigravityToolBreakdownRow[]
  topFiles: AntigravityFileActivityRow[]
  recentSessions: AntigravityUsageSessionRow[]
}

export function createAntigravityContextUsage(
  inputTokens: number,
  contextWindow = 1_048_576
): {
  usedTokens: number
  windowTokens: number
  percentage: number
  estimated: boolean
  categories: readonly { name: string; tokens: number }[]
} {
  const percentage = contextWindow > 0 ? Math.round((inputTokens / contextWindow) * 1000) / 10 : 0
  return {
    usedTokens: inputTokens,
    windowTokens: contextWindow,
    percentage,
    estimated: true,
    categories: [{ name: 'Input & Context', tokens: inputTokens }]
  }
}
