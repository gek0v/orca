import { AlertTriangle } from 'lucide-react'
import React from 'react'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import {
  getDisplayedUsagePercentage,
  type UsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'
import type { StatusBarUsageMode } from '../../../../shared/status-bar-usage-mode'
import {
  ProviderIcon,
  USAGE_URGENT_PERCENT,
  USAGE_WARNING_PERCENT,
  clampUsedPercent,
  getProviderDisplayName,
  getProviderUsageStatusLabel
} from './tooltip'
import { getTightestUsageSection, getUsageHeadlineSection } from './UsageRosterPanel'
import { getQuotaBarColorClass } from './status-bar-quota-tones'
import { translate } from '@/i18n/i18n'
import {
  useActiveWindowAntigravityAccount,
  useAntigravityAccounts
} from '@/hooks/useAntigravityAccounts'
import { useResetCountdownClock } from '@/hooks/useResetCountdownClock'
import {
  formatCompactExtraUsage,
  getAntigravityStatusBarWindows,
  getAntigravityStatusTightestSection,
  isExtraUsageActive
} from './status-bar-provider-buckets'
import { WindowLabel } from './status-bar-window-label'
import {
  AntigravityStatusAccountBadge,
  AntigravityStatusBarUsage
} from './status-bar-antigravity-usage'
import { VerboseProviderUsage } from './status-bar-verbose-usage'

export {
  formatStatusBarBucketLabel,
  getAntigravityStatusBarWindows,
  getAntigravityStatusTightestSection,
  isExternalAntigravityModel,
  isVisibleStatusBarBucket
} from './status-bar-provider-buckets'

function MiniBar({
  usedPct,
  display
}: {
  usedPct: number
  display: UsagePercentageDisplay
}): React.JSX.Element {
  return (
    <div
      data-usage-bar
      className="h-[5px] w-[36px] flex-shrink-0 overflow-hidden rounded-full bg-muted/70"
    >
      <div
        className={`h-full rounded-full transition-all duration-300 ${getQuotaBarColorClass(usedPct)}`}
        style={{ width: `${getDisplayedUsagePercentage(usedPct, display)}%` }}
      />
    </div>
  )
}

// Single-letter provider badge for the icon-only (narrow) status bar. Shared by
// the roster trigger and ProviderDetailsMenu so the dot's has-data condition
// and markup can't drift between the two.
export function ProviderLetterBadge({ p }: { p: ProviderRateLimits }): React.JSX.Element {
  const hasData = Boolean(p.session || p.weekly || p.fableWeekly || p.monthly || p.buckets?.length)
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <span
        className={`inline-block h-2 w-2 rounded-full ${hasData ? 'bg-muted-foreground/60' : 'bg-muted-foreground/30'}`}
      />
      {getProviderLetter(p.provider)}
    </span>
  )
}

export type UsageTone = 'urgent' | 'warning' | 'normal'

/** Urgency by consumption, matching the usage bar colors, whatever % display the user chose. */
export function getUsageTone(p: ProviderRateLimits): UsageTone {
  const tightest =
    p.provider === 'antigravity' && p.buckets && p.buckets.length > 0
      ? getAntigravityStatusTightestSection(p)
      : getTightestUsageSection(p)
  const used = tightest ? clampUsedPercent(tightest.window.usedPercent) : 0
  return used >= USAGE_URGENT_PERCENT
    ? 'urgent'
    : used >= USAGE_WARNING_PERCENT
      ? 'warning'
      : 'normal'
}

/**
 * Stands in for usage chips a narrow bar can't fit. Always rendered at the collapsing
 * density so its width is known before anything collapses; out of the row while empty.
 */
export function UsageOverflowChip({
  hidden,
  display
}: {
  hidden: readonly ProviderRateLimits[]
  display: UsagePercentageDisplay
}): React.JSX.Element {
  const tones = hidden.map(getUsageTone)
  const tone = tones.includes('urgent')
    ? 'urgent'
    : tones.includes('warning')
      ? 'warning'
      : 'normal'
  const names = hidden
    .map((p) => {
      const tightest =
        p.provider === 'antigravity' && p.buckets && p.buckets.length > 0
          ? getAntigravityStatusTightestSection(p)
          : getTightestUsageSection(p)
      const name = getProviderDisplayName(p.provider)
      if (!tightest) {
        return name
      }
      const pct = getDisplayedUsagePercentage(tightest.window.usedPercent, display)
      return `${name} ${pct}%`
    })
    .join(', ')
  return (
    <span
      data-usage-more
      data-usage-collapsed={hidden.length === 0}
      data-tone={tone}
      aria-hidden={hidden.length === 0}
      title={translate(
        'auto.components.status.bar.StatusBar.hiddenUsageProviders',
        'Also: {{value0}}',
        {
          value0: names
        }
      )}
      className="inline-flex h-4 items-center rounded-full border border-border px-1.5 text-[11px] font-medium tabular-nums text-foreground data-[tone=urgent]:border-destructive/40 data-[tone=urgent]:text-destructive data-[tone=warning]:border-status-warning-border data-[tone=warning]:text-status-warning data-[usage-collapsed=true]:invisible data-[usage-collapsed=true]:absolute"
    >
      +{Math.max(1, hidden.length)}
    </span>
  )
}

function getProviderLetter(provider: ProviderRateLimits['provider']): string {
  switch (provider) {
    case 'claude':
      return 'C'
    case 'gemini':
      return 'G'
    case 'opencode-go':
      return 'O'
    case 'kimi':
      return 'K'
    case 'antigravity':
      return 'A'
    case 'minimax':
      return 'M'
    case 'grok':
      return 'R'
    case 'cursor':
      return 'U'
    case 'zcode':
      return 'Z'
    case 'codex':
      return 'X'
  }
}

export function ProviderSegment({
  p,
  compact,
  display,
  mode = 'verbose',
  tightestOnly = false
}: {
  p: ProviderRateLimits | null
  compact: boolean
  display: UsagePercentageDisplay
  mode?: StatusBarUsageMode
  tightestOnly?: boolean
}): React.JSX.Element {
  const provider = p?.provider ?? 'claude'
  const isAntigravity = provider === 'antigravity'
  const displayedAccount = useActiveWindowAntigravityAccount()
  const { activeAccount: systemActiveAccount } = useAntigravityAccounts()

  let effectiveLimits = p
  if (isAntigravity) {
    if (displayedAccount) {
      if (displayedAccount.id !== systemActiveAccount?.id) {
        effectiveLimits = displayedAccount.lastUsage ?? null
      } else if (
        p?.usageMetadata?.authProvenance &&
        p.usageMetadata.authProvenance !== displayedAccount.id
      ) {
        effectiveLimits = displayedAccount.lastUsage
          ? {
              ...displayedAccount.lastUsage,
              status: p.status === 'fetching' ? 'fetching' : displayedAccount.lastUsage.status
            }
          : null
      } else {
        effectiveLimits = p
      }
    } else {
      effectiveLimits = p
    }
  }

  const limits = isAntigravity ? effectiveLimits : p
  const statusLabel = limits ? getProviderUsageStatusLabel(limits) : ''

  const resetTimes = React.useMemo(() => {
    if (!limits) {
      return []
    }
    if (limits.provider === 'antigravity') {
      const { fiveHour, weekly } = getAntigravityStatusBarWindows(limits)
      return [fiveHour?.resetsAt, weekly?.resetsAt]
    }
    return [limits.session?.resetsAt, limits.weekly?.resetsAt]
  }, [limits])
  const now = useResetCountdownClock(resetTimes)

  // Idle / initial load
  if (!limits || limits.status === 'idle') {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <ProviderIcon provider={provider} />
        {isAntigravity ? (
          <AntigravityStatusAccountBadge compact={compact} account={displayedAccount} />
        ) : null}
        <span className="animate-pulse">···</span>
      </span>
    )
  }

  const tightest =
    limits.provider === 'antigravity' && limits.buckets && limits.buckets.length > 0
      ? getAntigravityStatusTightestSection(limits)
      : mode === 'compact'
        ? getUsageHeadlineSection(limits)
        : getTightestUsageSection(limits)

  // Fetching with no prior data
  if (limits.status === 'fetching' && !tightest) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <ProviderIcon provider={provider} />
        {isAntigravity ? (
          <AntigravityStatusAccountBadge compact={compact} account={displayedAccount} />
        ) : null}
        <span className="animate-pulse">···</span>
      </span>
    )
  }

  // Unavailable (CLI not installed)
  if (limits.status === 'unavailable') {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground/50">
        <ProviderIcon provider={provider} />
        {isAntigravity ? (
          <AntigravityStatusAccountBadge compact={compact} account={displayedAccount} />
        ) : null}{' '}
        --
      </span>
    )
  }

  // Error with no data
  if (limits.status === 'error' && !tightest) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <ProviderIcon provider={provider} />
        {isAntigravity ? (
          <AntigravityStatusAccountBadge compact={compact} account={displayedAccount} />
        ) : null}
        <AlertTriangle size={11} className="text-muted-foreground/80" />
        {!compact && <span className="text-[11px] font-medium">{statusLabel}</span>}
      </span>
    )
  }

  // Has data (ok, fetching with stale data, or error with stale data)
  const isStale = limits.status === 'error'
  const showBalance = isExtraUsageActive(limits)

  return (
    <span className="inline-flex items-center gap-1.5">
      <ProviderIcon provider={provider} />
      {isAntigravity ? (
        <AntigravityStatusAccountBadge compact={compact} account={displayedAccount} />
      ) : null}
      {isAntigravity ? (
        <AntigravityStatusBarUsage
          p={limits}
          display={display}
          now={now}
          tightestOnly={tightestOnly}
        />
      ) : mode === 'verbose' ? (
        <>
          {tightest && !compact ? (
            <MiniBar usedPct={tightest.window.usedPercent} display={display} />
          ) : null}
          <VerboseProviderUsage p={limits} display={display} />
        </>
      ) : tightest ? (
        <WindowLabel
          w={tightest.window}
          label={tightest.label}
          display={display}
          showLabel={!compact}
        />
      ) : null}
      {showBalance && limits.extraUsage ? (
        <>
          <span className="text-muted-foreground">·</span>
          <span className="tabular-nums">{formatCompactExtraUsage(limits.extraUsage)}</span>
        </>
      ) : null}
      {isStale && <AlertTriangle size={11} className="text-muted-foreground/80" />}
    </span>
  )
}
