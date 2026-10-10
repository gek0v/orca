import React from 'react'
import type { RateLimitWindow } from '../../../../shared/rate-limit-types'
import {
  getDisplayedUsagePercentage,
  type UsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'
import { getQuotaTextColorClass } from './status-bar-quota-tones'

export function WindowLabel({
  w,
  label,
  display,
  showLabel = true
}: {
  w: RateLimitWindow
  label: string
  display: UsagePercentageDisplay
  showLabel?: boolean
}): React.JSX.Element {
  const pct = getDisplayedUsagePercentage(w.usedPercent, display)
  return (
    <span className="inline-flex items-center gap-1 font-medium tabular-nums">
      <span className={getQuotaTextColorClass(w.usedPercent)}>{pct}%</span>
      {showLabel ? <span className="text-[11px] text-muted-foreground">{label}</span> : null}
    </span>
  )
}
