import React from 'react'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import {
  getDisplayedUsagePercentage,
  type UsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'
import { getQuotaTextColorClass } from './status-bar-quota-tones'
import { formatRateLimitWindowChipLabel } from '@/lib/window-label-formatter'
import { translate } from '@/i18n/i18n'
import { formatStatusBarBucketLabel, isVisibleStatusBarBucket } from './status-bar-provider-buckets'
import { WindowLabel } from './status-bar-window-label'

export function VerboseProviderUsage({
  p,
  display
}: {
  p: ProviderRateLimits
  display: UsagePercentageDisplay
}): React.JSX.Element {
  if (p.buckets && p.buckets.length > 0) {
    const visibleBuckets = p.buckets.filter((bucket) =>
      isVisibleStatusBarBucket(bucket.name, p.provider)
    )
    // Why: a provider whose buckets are all filtered out still has a headline
    // window worth showing rather than rendering an empty segment.
    // Why weekly is in the chain: a tier metered weekly only (Antigravity reports no 5h pool on
    // some tiers) has no session window, and omitting weekly rendered an empty segment for an
    // account that does have a limit worth showing.
    const fallbackWindow = p.session ?? p.monthly ?? p.weekly ?? null
    return (
      <>
        {visibleBuckets.map((bucket, index) => {
          const pct = getDisplayedUsagePercentage(bucket.usedPercent, display)
          return (
            <React.Fragment key={bucket.name}>
              {index > 0 ? <span className="text-muted-foreground/50">·</span> : null}
              <span className="inline-flex items-center gap-1 font-medium tabular-nums">
                <span className="text-[11px] text-muted-foreground">
                  {formatStatusBarBucketLabel(bucket.name, p.provider, bucket.windowMinutes)}
                </span>
                <span className={getQuotaTextColorClass(bucket.usedPercent)}>{pct}%</span>
              </span>
            </React.Fragment>
          )
        })}
        {visibleBuckets.length === 0 && fallbackWindow ? (
          <WindowLabel
            w={fallbackWindow}
            label={formatRateLimitWindowChipLabel(fallbackWindow)}
            display={display}
          />
        ) : null}
      </>
    )
  }

  const visibleWindows = [
    p.session
      ? {
          key: 'session',
          window: p.session,
          label: formatRateLimitWindowChipLabel(p.session)
        }
      : null,
    p.weekly
      ? {
          key: 'weekly',
          window: p.weekly,
          label: formatRateLimitWindowChipLabel(p.weekly)
        }
      : null,
    p.fableWeekly
      ? {
          key: 'fableWeekly',
          window: p.fableWeekly,
          label: translate('auto.components.status.bar.StatusBar.a79c64f87e', 'Fable')
        }
      : null,
    // Why: monthly stays inline for monthly-only providers; otherwise the detail panel carries it.
    p.monthly && !p.session && !p.weekly
      ? {
          key: 'monthly',
          window: p.monthly,
          label: formatRateLimitWindowChipLabel(p.monthly)
        }
      : null
  ].filter((window): window is { key: string; window: RateLimitWindow; label: string } => {
    return window !== null
  })

  return (
    <>
      {visibleWindows.map((window, index) => (
        <React.Fragment key={window.key}>
          {index > 0 ? <span className="text-muted-foreground/50">·</span> : null}
          <WindowLabel w={window.window} label={window.label} display={display} />
        </React.Fragment>
      ))}
    </>
  )
}
