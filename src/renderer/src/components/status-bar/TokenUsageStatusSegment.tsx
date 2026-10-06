import React, { useEffect, useMemo, useState } from 'react'
import { ChevronRight, Database, ExternalLink, RotateCw } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { formatCost, formatSessionTime, formatTokens } from '../stats/usage-formatters'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'
import {
  aggregateProjectMetrics,
  aggregateRecentSessions,
  extractActiveProjectName
} from './token-usage-data-aggregation'

export function TokenUsageStatusSegment({
  iconOnly
}: {
  iconOnly: boolean
}): React.JSX.Element {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const claudeBreakdown = useAppStore((s) => s.claudeUsageProjectBreakdown)
  const codexBreakdown = useAppStore((s) => s.codexUsageProjectBreakdown)
  const openCodeBreakdown = useAppStore((s) => s.openCodeUsageProjectBreakdown)
  const museBreakdown = useAppStore((s) => s.museUsageProjectBreakdown)
  const antigravityBreakdown = useAppStore((s) => s.antigravityUsageProjectBreakdown)
  const claudeSessions = useAppStore((s) => s.claudeUsageRecentSessions)
  const codexSessions = useAppStore((s) => s.codexUsageRecentSessions)
  const openCodeSessions = useAppStore((s) => s.openCodeUsageRecentSessions)
  const museSessions = useAppStore((s) => s.museUsageRecentSessions)
  const antigravitySessions = useAppStore((s) => s.antigravityUsageRecentSessions)
  const claudeScanState = useAppStore((s) => s.claudeUsageScanState)
  const codexScanState = useAppStore((s) => s.codexUsageScanState)
  const fetchClaudeUsage = useAppStore((s) => s.fetchClaudeUsage)
  const fetchCodexUsage = useAppStore((s) => s.fetchCodexUsage)
  const fetchOpenCodeUsage = useAppStore((s) => s.fetchOpenCodeUsage)
  const fetchMuseUsage = useAppStore((s) => s.fetchMuseUsage)
  const fetchAntigravityUsage = useAppStore((s) => s.fetchAntigravityUsage)
  const refreshClaudeUsage = useAppStore((s) => s.refreshClaudeUsage)
  const refreshCodexUsage = useAppStore((s) => s.refreshCodexUsage)
  const refreshOpenCodeUsage = useAppStore((s) => s.refreshOpenCodeUsage)
  const refreshMuseUsage = useAppStore((s) => s.refreshMuseUsage)
  const refreshAntigravityUsage = useAppStore((s) => s.refreshAntigravityUsage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)

  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    void fetchClaudeUsage()
    void fetchCodexUsage()
    void fetchOpenCodeUsage()
    void fetchMuseUsage()
    void fetchAntigravityUsage()
  }, [fetchClaudeUsage, fetchCodexUsage, fetchOpenCodeUsage, fetchMuseUsage, fetchAntigravityUsage])

  const projectName = useMemo(
    () => extractActiveProjectName(activeWorktreeId, worktreesByRepo),
    [activeWorktreeId, worktreesByRepo]
  )

  const projectMetrics = useMemo(
    () =>
      aggregateProjectMetrics(projectName, {
        claude: claudeBreakdown,
        codex: codexBreakdown,
        opencode: openCodeBreakdown,
        muse: museBreakdown,
        antigravity: antigravityBreakdown
      }),
    [
      projectName,
      claudeBreakdown,
      codexBreakdown,
      openCodeBreakdown,
      museBreakdown,
      antigravityBreakdown
    ]
  )

  const recentSessions = useMemo(
    () =>
      aggregateRecentSessions(
        {
          claude: claudeSessions,
          codex: codexSessions,
          opencode: openCodeSessions,
          muse: museSessions,
          antigravity: antigravitySessions
        },
        projectName
      ),
    [
      projectName,
      claudeSessions,
      codexSessions,
      openCodeSessions,
      museSessions,
      antigravitySessions
    ]
  )

  const handleRefresh = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    setRefreshing(true)
    try {
      await Promise.allSettled([
        refreshClaudeUsage(),
        refreshCodexUsage(),
        refreshOpenCodeUsage(),
        refreshMuseUsage(),
        refreshAntigravityUsage()
      ])
    } finally {
      setRefreshing(false)
    }
  }

  const handleOpenStats = (sectionId?: string): void => {
    setOpen(false)
    openSettingsTarget({ pane: 'stats', repoId: null, sectionId })
    openSettingsPage()
  }

  const isScanning =
    refreshing || Boolean(claudeScanState?.isScanning) || Boolean(codexScanState?.isScanning)

  const hasData = projectMetrics.totalTokens > 0 || recentSessions.length > 0

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip delayDuration={150}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
              className="inline-flex items-center gap-1.5 cursor-pointer rounded px-1 py-0.5 hover:bg-accent/70 text-[11px] text-muted-foreground focus-visible:outline-none"
              aria-label={translate(
                'auto.components.status.bar.TokenUsageStatusSegment.ariaLabel',
                'Token usage'
              )}
            >
              <Database className="size-3 text-muted-foreground shrink-0" />
              {!iconOnly ? (
                <span className="tabular-nums font-medium text-muted-foreground">
                  {hasData
                    ? formatTokens(projectMetrics.totalTokens)
                    : translate('auto.components.status.bar.TokenUsageStatusSegment.label', 'Tokens')}
                </span>
              ) : null}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          {translate(
            'auto.components.status.bar.TokenUsageStatusSegment.tooltip',
            'Token usage: {{project}} ({{tokens}} tokens)',
            {
              project: projectMetrics.name,
              tokens: formatTokens(projectMetrics.totalTokens)
            }
          )}
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        align="end"
        side="top"
        sideOffset={8}
        {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
        className="w-[22rem] max-w-[calc(100vw-2rem)]"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onFocusOutside={(event) => event.preventDefault()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-foreground">
            <Database className="size-3 shrink-0 text-muted-foreground" />
            <span className="truncate">
              {translate('auto.components.status.bar.TokenUsageStatusSegment.title', 'Token Usage')}
            </span>
            {projectMetrics.name ? (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground truncate max-w-[130px]">
                {projectMetrics.name}
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-0.5">
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleRefresh}
                  disabled={isScanning}
                  aria-label={translate('auto.components.status.bar.TokenUsageStatusSegment.refresh', 'Refresh')}
                  className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 cursor-pointer"
                >
                  <RotateCw className={cn('size-3', isScanning && 'animate-spin')} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                {translate('auto.components.status.bar.TokenUsageStatusSegment.refresh', 'Refresh')}
              </TooltipContent>
            </Tooltip>

            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => handleOpenStats()}
                  aria-label={translate('auto.components.status.bar.TokenUsageStatusSegment.details', 'View full stats')}
                  className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
                >
                  <ExternalLink className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                {translate('auto.components.status.bar.TokenUsageStatusSegment.details', 'View full stats')}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Project Metrics Summary Strip */}
        <div className="border-b border-border bg-muted/15 px-3 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <div className="flex items-baseline gap-1.5">
              <span className="text-[11px] font-medium text-muted-foreground">
                {translate('auto.components.status.bar.TokenUsageStatusSegment.projectTokens', 'Project Tokens')}
              </span>
              <span className="text-sm font-semibold tabular-nums text-foreground">
                {formatTokens(projectMetrics.totalTokens)}
              </span>
            </div>
            {projectMetrics.cost !== null ? (
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {translate('auto.components.status.bar.TokenUsageStatusSegment.estimatedCost', 'Est.')}{' '}
                <span className="font-medium text-foreground">{formatCost(projectMetrics.cost)}</span>
              </span>
            ) : null}
          </div>

          <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
            <div className="flex flex-col">
              <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                <span className="size-1.5 rounded-full bg-chart-1 shrink-0" />
                {translate('auto.components.status.bar.TokenUsageStatusSegment.input', 'Input')}
              </span>
              <span className="font-medium tabular-nums text-foreground mt-0.5">
                {formatTokens(projectMetrics.inputTokens)}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                <span className="size-1.5 rounded-full bg-chart-2 shrink-0" />
                {translate('auto.components.status.bar.TokenUsageStatusSegment.output', 'Output')}
              </span>
              <span className="font-medium tabular-nums text-foreground mt-0.5">
                {formatTokens(projectMetrics.outputTokens)}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                <span className="size-1.5 rounded-full bg-chart-3 shrink-0" />
                {translate('auto.components.status.bar.TokenUsageStatusSegment.cache', 'Cache')}
              </span>
              <span className="font-medium tabular-nums text-foreground mt-0.5">
                {formatTokens(projectMetrics.cacheTokens)}
              </span>
            </div>
          </div>

          {projectMetrics.toolCalls > 0 ? (
            <button
              type="button"
              onClick={() => handleOpenStats('antigravity')}
              className="mt-2 pt-1.5 border-t border-border/40 flex w-full items-center justify-between text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer text-left"
            >
              <span className="font-medium text-foreground">
                {projectMetrics.toolCalls}{' '}
                {translate('auto.components.status.bar.TokenUsageStatusSegment.actions', 'actions')}
              </span>
              <span className="tabular-nums flex items-center gap-1">
                {projectMetrics.toolCategoryCounts.read ?? 0} reads · {projectMetrics.toolCategoryCounts.edit ?? 0} edits · {projectMetrics.toolCategoryCounts.terminal ?? 0} cmds
                <ChevronRight className="size-3 text-muted-foreground" />
              </span>
            </button>
          ) : null}
        </div>

        {/* Recent Sessions */}
        <div className="px-3 pt-2.5 pb-1 flex items-center justify-between text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          <span>
            {translate('auto.components.status.bar.TokenUsageStatusSegment.recentSessions', 'Recent Sessions')}
          </span>
          {recentSessions.length > 0 ? (
            <span className="normal-case font-normal text-muted-foreground/70">
              {recentSessions.length}{' '}
              {recentSessions.length === 1 ? 'session' : 'sessions'}
            </span>
          ) : null}
        </div>

        <div className="max-h-48 overflow-y-auto divide-y divide-border/30 scrollbar-sleek">
          {recentSessions.length === 0 ? (
            <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
              {translate('auto.components.status.bar.TokenUsageStatusSegment.noSessions', 'No sessions recorded yet.')}
            </div>
          ) : (
            recentSessions.map((session) => (
              <div
                key={`${session.provider}-${session.sessionId}`}
                onClick={() =>
                  handleOpenStats(
                    session.provider.toLowerCase() === 'antigravity'
                      ? 'antigravity'
                      : undefined
                  )
                }
                className="flex items-center justify-between px-3 py-1.5 text-[11px] hover:bg-accent/40 transition-colors cursor-pointer"
              >
                <div className="min-w-0 flex-1 pr-2">
                  <div className="flex items-center gap-1.5">
                    <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
                    <span className="font-medium text-foreground truncate">
                      {session.model || session.provider}
                    </span>
                    <span className="text-[10px] text-muted-foreground truncate">
                      · {session.provider}
                    </span>
                  </div>
                  <div className="pl-3 text-[10px] text-muted-foreground">
                    {formatSessionTime(session.lastActiveAt)}
                    <span className="mx-1">·</span>
                    {session.turns}{' '}
                    {translate('auto.components.status.bar.TokenUsageStatusSegment.turns', 'turns')}
                    {typeof session.toolCalls === 'number' && session.toolCalls > 0 ? (
                      <>
                        <span className="mx-1">·</span>
                        {session.toolCalls}{' '}
                        {translate('auto.components.status.bar.TokenUsageStatusSegment.actions', 'actions')}
                      </>
                    ) : null}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <span className="font-medium tabular-nums text-foreground">
                    {formatTokens(session.totalTokens)}
                  </span>
                  <span className="block text-[10px] text-muted-foreground">tokens</span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border/70" />
        <button
          type="button"
          onClick={() => handleOpenStats()}
          className="flex w-full cursor-pointer items-center justify-between px-3 py-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          <span>
            {translate('auto.components.status.bar.TokenUsageStatusSegment.viewAnalytics', 'Usage details & history')}
          </span>
          <ChevronRight className="size-3.5 text-muted-foreground" />
        </button>
      </PopoverContent>
    </Popover>
  )
}
