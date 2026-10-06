import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import type { AntigravityUsageDailyPoint } from '../../../../shared/antigravity-usage-types'
import { translate } from '@/i18n/i18n'

function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`
  }
  return value.toLocaleString()
}

function getMaxDailyTotal(daily: AntigravityUsageDailyPoint[]): number {
  let max = 1
  for (const entry of daily) {
    max = Math.max(max, entry.totalTokens)
  }
  return max
}

type AntigravityUsageDailyChartProps = {
  daily: AntigravityUsageDailyPoint[]
}

export function AntigravityUsageDailyChart({
  daily
}: AntigravityUsageDailyChartProps): React.JSX.Element {
  const maxDailyTotal = getMaxDailyTotal(daily)

  return (
    <section className="rounded-lg border border-border/60 bg-card/40 p-4">
      <div className="mb-3">
        <h4 className="text-sm font-semibold text-foreground">
          {translate('auto.components.stats.AntigravityUsageDailyChart.dailyUsage', 'Daily usage')}
        </h4>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.stats.AntigravityUsageDailyChart.chartDescription',
            'Input, cached input, and output totals by day.'
          )}
        </p>
      </div>
      <div className="grid h-56 grid-cols-10 items-end gap-3">
        {daily.slice(-10).map((entry) => {
          const segments = [
            {
              key: 'input',
              label: translate(
                'auto.components.stats.AntigravityUsageDailyChart.input',
                'Input'
              ),
              value: Math.max(0, entry.inputTokens - entry.cachedInputTokens),
              className: 'bg-chart-1'
            },
            {
              key: 'output',
              label: translate(
                'auto.components.stats.AntigravityUsageDailyChart.output',
                'Output'
              ),
              value: entry.outputTokens,
              className: 'bg-chart-2'
            },
            {
              key: 'cached-input',
              label: translate(
                'auto.components.stats.AntigravityUsageDailyChart.cachedInput',
                'Cached input'
              ),
              value: entry.cachedInputTokens,
              className: 'bg-chart-3'
            }
          ]
          return (
            <div key={entry.day} className="flex h-full min-w-0 flex-col justify-end gap-2">
              <span className="text-center text-[11px] text-muted-foreground">
                {formatTokens(entry.totalTokens)}
              </span>
              <div className="flex min-h-0 flex-1 items-end justify-center">
                <div className="flex h-full w-full max-w-12 overflow-hidden rounded-t-sm bg-muted/60">
                  <div className="flex h-full w-full flex-col justify-end">
                    {segments.map((segment) =>
                      segment.value > 0 ? (
                        <TooltipProvider key={segment.key} delayDuration={120}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div
                                className={segment.className}
                                style={{ height: `${(segment.value / maxDailyTotal) * 100}%` }}
                              />
                            </TooltipTrigger>
                            <TooltipContent side="top" sideOffset={8}>
                              <div className="text-xs">
                                <div>{entry.day}</div>
                                <div>
                                  {segment.label}: {segment.value.toLocaleString()}{' '}
                                  {translate(
                                    'auto.components.stats.AntigravityUsageDailyChart.tokens',
                                    'tokens'
                                  )}
                                </div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : null
                    )}
                  </div>
                </div>
              </div>
              <span className="text-center text-[11px] text-muted-foreground">
                {entry.day.slice(5)}
              </span>
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <span className="size-2 rounded-full bg-chart-1" />
          {translate('auto.components.stats.AntigravityUsageDailyChart.input', 'Input')}
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="size-2 rounded-full bg-chart-2" />
          {translate('auto.components.stats.AntigravityUsageDailyChart.output', 'Output')}
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="size-2 rounded-full bg-chart-3" />
          {translate(
            'auto.components.stats.AntigravityUsageDailyChart.cachedInput',
            'Cached input'
          )}
        </span>
      </div>
    </section>
  )
}
