import type { AntigravityToolCategory } from '../../../../shared/antigravity-usage-types'

const ANTIGRAVITY_CATEGORIES: readonly AntigravityToolCategory[] = [
  'terminal',
  'edit',
  'read',
  'search',
  'subagent',
  'other'
]

export type ProjectTokenMetrics = {
  name: string
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  totalTokens: number
  cost: number | null
  turns: number
  sessions: number
  toolCalls: number
  toolCategoryCounts: Record<AntigravityToolCategory, number>
}

export type SessionItem = {
  sessionId: string
  lastActiveAt: string
  projectLabel: string
  model: string | null
  turns: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  provider: string
  toolCalls?: number
}

type GenericBreakdownRow = {
  key?: string
  label?: string
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  turns?: number
  sessions?: number
  estimatedCostUsd?: number | null
  totalToolCalls?: number
  toolCategoryCounts?: Record<AntigravityToolCategory, number>
}

function isBreakdownRow(val: unknown): val is GenericBreakdownRow {
  return typeof val === 'object' && val !== null
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null
}

export function extractActiveProjectName(
  activeWorktreeId: string | null,
  worktreesByRepo: Record<string, { id: string; name?: string; path?: string }[]>
): string | null {
  if (!activeWorktreeId) {
    return null
  }
  for (const list of Object.values(worktreesByRepo)) {
    const wt = list.find((item) => item.id === activeWorktreeId)
    if (wt) {
      return wt.name || wt.path?.split(/[\\/]/).pop() || null
    }
  }
  return null
}

export function aggregateProjectMetrics(
  projectName: string | null,
  breakdowns: {
    claude: readonly unknown[]
    codex: readonly unknown[]
    opencode: readonly unknown[]
    muse: readonly unknown[]
    antigravity?: readonly unknown[]
  }
): ProjectTokenMetrics {
  const norm = projectName?.trim().toLowerCase() ?? ''
  let input = 0
  let output = 0
  let cache = 0
  let turns = 0
  let sessions = 0
  let cost = 0
  let hasCost = false
  let totalTools = 0
  const toolCounts: Record<AntigravityToolCategory, number> = {
    terminal: 0,
    edit: 0,
    read: 0,
    search: 0,
    subagent: 0,
    other: 0
  }

  const allRows: GenericBreakdownRow[] = [
    ...breakdowns.claude.filter(isBreakdownRow),
    ...breakdowns.codex.filter(isBreakdownRow),
    ...breakdowns.opencode.filter(isBreakdownRow),
    ...breakdowns.muse.filter(isBreakdownRow),
    ...(breakdowns.antigravity ?? []).filter(isBreakdownRow)
  ]

  for (const r of allRows) {
    const label = r.label ?? ''
    const key = r.key ?? ''
    const match = !norm || label.toLowerCase().includes(norm) || key.toLowerCase().includes(norm)
    if (match) {
      const inTok = r.inputTokens ?? 0
      const outTok = r.outputTokens ?? 0
      const cTok = (r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0) + (r.cachedInputTokens ?? 0)
      input += inTok
      output += outTok
      cache += cTok
      turns += r.turns ?? 0
      sessions += r.sessions ?? 0
      if (r.estimatedCostUsd !== null && r.estimatedCostUsd !== undefined) {
        cost += r.estimatedCostUsd
        hasCost = true
      }
      if (r.totalToolCalls) {
        totalTools += r.totalToolCalls
      }
      if (r.toolCategoryCounts) {
        for (const cat of ANTIGRAVITY_CATEGORIES) {
          const count = r.toolCategoryCounts[cat]
          if (typeof count === 'number') {
            toolCounts[cat] += count
          }
        }
      }
    }
  }

  return {
    name: projectName || 'Global',
    inputTokens: input,
    outputTokens: output,
    cacheTokens: cache,
    totalTokens: input + output,
    cost: hasCost ? cost : null,
    turns,
    sessions,
    toolCalls: totalTools,
    toolCategoryCounts: toolCounts
  }
}

export function aggregateRecentSessions(
  lists: {
    claude: readonly unknown[]
    codex: readonly unknown[]
    opencode: readonly unknown[]
    muse: readonly unknown[]
    antigravity?: readonly unknown[]
  },
  projectName: string | null,
  limit = 4
): SessionItem[] {
  const norm = projectName?.trim().toLowerCase() ?? ''

  function parseRows(rows: readonly unknown[], provider: string): SessionItem[] {
    const result: SessionItem[] = []
    for (const r of rows) {
      if (isRecord(r)) {
        const inTok = typeof r.inputTokens === 'number' ? r.inputTokens : 0
        const outTok = typeof r.outputTokens === 'number' ? r.outputTokens : 0
        result.push({
          sessionId: typeof r.sessionId === 'string' ? r.sessionId : '',
          lastActiveAt: typeof r.lastActiveAt === 'string' ? r.lastActiveAt : '',
          projectLabel: typeof r.projectLabel === 'string' ? r.projectLabel : '',
          model: typeof r.model === 'string' ? r.model : null,
          turns: typeof r.turns === 'number' ? r.turns : 0,
          inputTokens: inTok,
          outputTokens: outTok,
          totalTokens: inTok + outTok,
          provider,
          toolCalls: typeof r.toolCalls === 'number' ? r.toolCalls : undefined
        })
      }
    }
    return result
  }

  const combined: SessionItem[] = [
    ...parseRows(lists.claude, 'Claude'),
    ...parseRows(lists.codex, 'Codex'),
    ...parseRows(lists.opencode, 'OpenCode'),
    ...parseRows(lists.muse, 'Muse'),
    ...parseRows(lists.antigravity ?? [], 'Antigravity')
  ]

  const filtered = norm
    ? combined.filter((s) => s.projectLabel.toLowerCase().includes(norm))
    : combined

  const source = filtered.length > 0 ? filtered : combined
  return source
    .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
    .slice(0, limit)
}
