import React from 'react'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import type { UsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import type { AntigravityAccountSummary } from '../../../../shared/antigravity-account-types'
import { useActiveWindowAntigravityAccount } from '@/hooks/useAntigravityAccounts'
import { formatCompactRateLimitWindowChipLabel } from '@/lib/window-label-formatter'
import {
  getAntigravityStatusBarWindows,
  getAntigravityStatusTightestSection
} from './status-bar-provider-buckets'
import { WindowLabel } from './status-bar-window-label'

export function AntigravityStatusAccountBadge({
  compact,
  account
}: {
  compact: boolean
  account?: AntigravityAccountSummary | null
}): React.JSX.Element | null {
  const activeWindowAccount = useActiveWindowAntigravityAccount()
  const resolvedAccount = account !== undefined ? account : activeWindowAccount
  if (!resolvedAccount) {
    return null
  }
  const label = resolvedAccount.alias?.trim() || resolvedAccount.email?.split('@')[0] || ''
  if (!label && !resolvedAccount.emoji) {
    return null
  }
  return (
    <span
      data-antigravity-status-account
      className={`inline-flex items-center gap-1 font-medium text-foreground ${compact ? 'max-w-[70px]' : 'max-w-[120px]'} truncate text-[11px]`}
      title={resolvedAccount.email ?? undefined}
    >
      {resolvedAccount.emoji ? (
        <span
          className="select-none leading-none text-[12px]"
          data-account-emoji={resolvedAccount.emoji}
        >
          {resolvedAccount.emoji}
        </span>
      ) : null}
      {label ? <span className="truncate">{label}</span> : null}
    </span>
  )
}

export function AntigravityStatusBarUsage({
  p,
  display,
  now,
  tightestOnly = false
}: {
  p: ProviderRateLimits
  display: UsagePercentageDisplay
  now: number
  tightestOnly?: boolean
}): React.JSX.Element {
  const tightest = getAntigravityStatusTightestSection(p)
  if (tightestOnly && tightest) {
    const countdown = formatCompactRateLimitWindowChipLabel(tightest.window, now)
    return (
      <WindowLabel
        w={tightest.window}
        label={`(${countdown})`}
        display={display}
        showLabel={true}
      />
    )
  }

  const { fiveHour, weekly } = getAntigravityStatusBarWindows(p)
  const windows = [
    fiveHour ? { key: '5h', window: fiveHour } : null,
    weekly ? { key: 'weekly', window: weekly } : null
  ].filter((w): w is { key: string; window: RateLimitWindow } => w !== null)

  const items =
    windows.length > 0
      ? windows
      : (() => {
          const fallback = p.session ?? p.monthly ?? p.weekly ?? null
          return fallback ? [{ key: 'fallback', window: fallback }] : []
        })()

  return (
    <>
      {items.map((item, index) => {
        const countdown = formatCompactRateLimitWindowChipLabel(item.window, now)
        return (
          <React.Fragment key={item.key}>
            {index > 0 ? <span className="text-muted-foreground/50">·</span> : null}
            <WindowLabel
              w={item.window}
              label={`(${countdown})`}
              display={display}
              showLabel={true}
            />
          </React.Fragment>
        )
      })}
    </>
  )
}
