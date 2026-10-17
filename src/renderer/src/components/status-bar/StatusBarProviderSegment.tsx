import { AlertTriangle } from 'lucide-react'
import React from 'react'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
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
import { isClaudeUsageWaitingForClaude } from './usage-error-copy'
import { getTightestUsageSection, getUsageHeadlineSection } from './UsageRosterPanel'
import { getQuotaBarColorClass } from './status-bar-quota-tones'
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
import {
  AntigravityStatusAccountBadge,
  AntigravityStatusBarUsage
} from './status-bar-antigravity-usage'
import { formatBareUsagePercentage, formatUsagePercentageLabel } from './usage-percentage-label'
import { translate } from '@/i18n/i18n'
import { getStatusBarUsageSections } from './status-bar-usage-sections'

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

function WindowLabel({
  w,
  label,
  display,
  showLabel = true,
  labelFirst = false
}: {
  w: RateLimitWindow
  label: string
  display: UsagePercentageDisplay
  showLabel?: boolean
  labelFirst?: boolean
}): React.JSX.Element {
  return (
    <span className="tabular-nums">
      {showLabel && labelFirst ? `${label} ` : ''}
      {formatBareUsagePercentage(w.usedPercent, display)}
      {showLabel && !labelFirst ? ` ${label}` : ''}
    </span>
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
  providerCount,
  display
}: {
  hidden: readonly ProviderRateLimits[]
  providerCount: number
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
      return `${name} ${formatUsagePercentageLabel(tightest.window.usedPercent, display)}`
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
      className="inline-grid h-4 items-center justify-items-center rounded-full border border-border px-1.5 text-[11px] font-medium tabular-nums text-foreground data-[tone=urgent]:border-destructive/40 data-[tone=urgent]:text-destructive data-[tone=warning]:border-status-warning-border data-[tone=warning]:text-status-warning data-[usage-collapsed=true]:invisible data-[usage-collapsed=true]:absolute"
    >
      {/* Why: count changes must not invalidate density measurements and restart probing. */}
      <span aria-hidden="true" className="invisible col-start-1 row-start-1">
        +{providerCount}
      </span>
      <span className="col-start-1 row-start-1">+{Math.max(1, hidden.length)}</span>
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
      if (displayedAccount.lastUsage) {
        effectiveLimits = {
          ...displayedAccount.lastUsage,
          status: p?.status === 'fetching' ? 'fetching' : displayedAccount.lastUsage.status
        }
      } else if (
        displayedAccount.id !== systemActiveAccount?.id ||
        (p?.usageMetadata?.authProvenance && p.usageMetadata.authProvenance !== displayedAccount.id)
      ) {
        effectiveLimits = null
      } else {
        effectiveLimits = p
      }
    } else {
      effectiveLimits = p
    }
  }

  const limits = isAntigravity ? effectiveLimits : p
  const statusLabel = limits ? getProviderUsageStatusLabel(limits) : ''
  // Why: not a problem; Claude updates its own login the next time it runs.
  const calm = limits ? isClaudeUsageWaitingForClaude(limits) : false

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
        {!calm && <AlertTriangle size={11} className="text-muted-foreground/80" />}
        {!compact && <span className="text-[11px] font-medium">{statusLabel}</span>}
      </span>
    )
  }

  const isStale = (limits?.status === 'error' || p?.status === 'error') && !calm
  const showBalance = limits ? isExtraUsageActive(limits) : false
  const sections = getStatusBarUsageSections(limits, mode)

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
      ) : (
        <>
          {mode === 'verbose' && tightest && !compact ? (
            <MiniBar usedPct={tightest.window.usedPercent} display={display} />
          ) : null}
          {sections.map((section, index) => (
            <React.Fragment key={section.key}>
              {index > 0 ? <span className="text-muted-foreground">·</span> : null}
              <WindowLabel
                w={section.window}
                label={section.label}
                display={display}
                showLabel={mode === 'verbose' || !compact}
                labelFirst={section.labelFirst}
              />
            </React.Fragment>
          ))}
        </>
      )}
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
