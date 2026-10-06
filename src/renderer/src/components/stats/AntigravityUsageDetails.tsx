import type {
  AntigravityFileActivityRow,
  AntigravityToolBreakdownRow,
  AntigravityUsageBreakdownRow,
  AntigravityUsageDailyPoint,
  AntigravityUsageSessionRow,
  AntigravityUsageSummary
} from '../../../../shared/antigravity-usage-types'
import { AntigravityUsageDailyChart } from './AntigravityUsageDailyChart'
import { UsageBreakdownSection } from './UsageBreakdownSection'
import { UsageRecentSessionsTable } from './UsageRecentSessionsTable'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

const CATEGORY_BAR_COLORS: Record<string, string> = {
  terminal: 'bg-chart-1',
  edit: 'bg-chart-2',
  read: 'bg-chart-3',
  search: 'bg-chart-4',
  subagent: 'bg-chart-5',
  other: 'bg-muted-foreground/40'
}

function AntigravityToolCategoryBreakdown({
  breakdown,
  totalCalls
}: {
  breakdown: AntigravityToolBreakdownRow[]
  totalCalls: number
}): React.JSX.Element {
  return (
    <section className="rounded-lg border border-border/60 bg-card/40 p-4">
      <div className="mb-3">
        <h4 className="text-sm font-semibold text-foreground">
          {translate('auto.components.stats.AntigravityUsagePane.byToolCategory', 'By tool category')}
        </h4>
        <p className="text-xs text-muted-foreground">
          {translate('auto.components.stats.AntigravityUsagePane.totalActions', 'Total actions:')}{' '}
          <span className="font-medium text-foreground">{totalCalls.toLocaleString()}</span>
        </p>
      </div>
      <div className="space-y-2.5">
        {breakdown.length === 0 ? (
          <p className="text-xs text-muted-foreground py-2">
            {translate('auto.components.stats.AntigravityUsagePane.noActions', 'No tool activity recorded.')}
          </p>
        ) : (
          breakdown.map((row) => (
            <div key={row.category} className="space-y-1">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="text-foreground">{row.label}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {row.count.toLocaleString()}{' '}
                  <span className="text-[10px] text-muted-foreground/70">({row.percentage}%)</span>
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-muted/40 overflow-hidden">
                <div
                  className={cn(
                    'h-full rounded-full transition-all duration-300',
                    CATEGORY_BAR_COLORS[row.category] ?? 'bg-chart-1'
                  )}
                  style={{ width: `${Math.min(100, Math.max(0, row.percentage))}%` }}
                />
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  )
}

function AntigravityActiveFilesList({
  topFiles,
  totalFiles
}: {
  topFiles: AntigravityFileActivityRow[]
  totalFiles: number
}): React.JSX.Element {
  return (
    <section className="rounded-lg border border-border/60 bg-card/40 p-4 flex flex-col">
      <div className="mb-3">
        <h4 className="text-sm font-semibold text-foreground">
          {translate('auto.components.stats.AntigravityUsagePane.mostActiveFiles', 'Most active files')}
        </h4>
        <p className="text-xs text-muted-foreground">
          {translate('auto.components.stats.AntigravityUsagePane.filesTouched', 'Files touched:')}{' '}
          <span className="font-medium text-foreground">{totalFiles.toLocaleString()}</span>
        </p>
      </div>
      <div className="max-h-56 overflow-y-auto divide-y divide-border/30 scrollbar-sleek -mx-1 px-1 flex-1">
        {topFiles.length === 0 ? (
          <p className="text-xs text-muted-foreground py-2">
            {translate(
              'auto.components.stats.AntigravityUsagePane.noFilesTouched',
              'No file activity recorded in this scope.'
            )}
          </p>
        ) : (
          topFiles.slice(0, 15).map((file) => (
            <div
              key={file.path}
              className="flex items-center justify-between gap-2 py-1.5 text-[11px] hover:bg-accent/40 px-1.5 rounded transition-colors"
            >
              <span
                className="font-mono text-[10px] text-foreground truncate min-w-0 flex-1"
                title={file.path}
              >
                {file.path}
              </span>
              <div className="flex items-center gap-1.5 shrink-0 text-[10px] tabular-nums text-muted-foreground">
                {file.reads > 0 ? (
                  <span className="rounded bg-muted/60 px-1 py-0.5">
                    {file.reads} {translate('auto.components.stats.AntigravityUsagePane.reads', 'reads')}
                  </span>
                ) : null}
                {file.edits > 0 ? (
                  <span className="rounded bg-muted/60 px-1 py-0.5 text-foreground font-medium">
                    {file.edits} {translate('auto.components.stats.AntigravityUsagePane.edits', 'edits')}
                  </span>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  )
}

type AntigravityUsageDetailsProps = {
  daily: AntigravityUsageDailyPoint[]
  modelBreakdown: AntigravityUsageBreakdownRow[]
  projectBreakdown: AntigravityUsageBreakdownRow[]
  recentSessions: AntigravityUsageSessionRow[]
  summary: AntigravityUsageSummary | null | undefined
}

export function AntigravityUsageDetails({
  daily,
  modelBreakdown,
  projectBreakdown,
  recentSessions,
  summary
}: AntigravityUsageDetailsProps): React.JSX.Element {
  return (
    <>
      <AntigravityUsageDailyChart daily={daily} />

      <div className="grid gap-4 xl:grid-cols-2">
        <UsageBreakdownSection
          title={translate('auto.components.stats.AntigravityUsagePane.byModel', 'By model')}
          topLabel={translate('auto.components.stats.AntigravityUsagePane.topModel', 'Top model:')}
          topValue={summary?.topModel}
          rows={modelBreakdown.map((row) => ({
            key: row.key,
            label: row.label,
            tokens: row.totalTokens,
            sessions: row.sessions,
            eventsOrTurns: row.turns
          }))}
          eventsOrTurns="turns"
        />
        <UsageBreakdownSection
          title={translate('auto.components.stats.AntigravityUsagePane.byProject', 'By project')}
          topLabel={translate(
            'auto.components.stats.AntigravityUsagePane.topProject',
            'Top project:'
          )}
          topValue={summary?.topProject}
          rows={projectBreakdown.map((row) => ({
            key: row.key,
            label: row.label,
            tokens: row.totalTokens,
            sessions: row.sessions,
            eventsOrTurns: row.turns
          }))}
          eventsOrTurns="turns"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <AntigravityToolCategoryBreakdown
          breakdown={summary?.toolBreakdown ?? []}
          totalCalls={summary?.totalToolCalls ?? 0}
        />
        <AntigravityActiveFilesList
          topFiles={summary?.topFiles ?? []}
          totalFiles={summary?.totalFilesTouched ?? 0}
        />
      </div>

      <UsageRecentSessionsTable
        title={translate(
          'auto.components.stats.AntigravityUsagePane.recentSessions',
          'Recent sessions'
        )}
        description={translate(
          'auto.components.stats.AntigravityUsagePane.recentSessionsDescription',
          'Most recent local Antigravity sessions in this scope.'
        )}
        headings={[
          translate('auto.components.stats.AntigravityUsagePane.lastActive', 'Last active'),
          translate('auto.components.stats.AntigravityUsagePane.project', 'Project'),
          translate('auto.components.stats.AntigravityUsagePane.model', 'Model'),
          translate('auto.components.stats.AntigravityUsagePane.turns', 'Turns'),
          translate('auto.components.stats.AntigravityUsagePane.input', 'Input'),
          translate('auto.components.stats.AntigravityUsagePane.output', 'Output'),
          translate('auto.components.stats.AntigravityUsagePane.total', 'Total')
        ]}
        unknownModel={translate('auto.components.stats.AntigravityUsagePane.unknown', 'Unknown')}
        rows={recentSessions}
        getActivity={(row) => row.turns}
        getTrailingTokens={(row) => row.totalTokens}
      />
    </>
  )
}
