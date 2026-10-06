import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { clampUsedPercent } from './tooltip'
import { getTightestUsageSection, type UsageSection } from './UsageRosterPanel'
import { isCursorUsageBucket } from '../../../../shared/cursor-usage-buckets'
import { formatCurrencyAmount } from '../../../../shared/currency-format'
import { formatCreditCount } from '../../../../shared/credit-count-format'
import { translate } from '@/i18n/i18n'

// Why: Gemini exposes extra experimental buckets that made the pre-existing verbose footer noisy.
const STATUS_BAR_BUCKET_NAMES = new Set(['Flash', 'Pro', '1.5 Pro'])

// A plan spends into its overage balance only once an included window is
// exhausted. Treat ~100% as capped to tolerate provider rounding.
const CAP_THRESHOLD_PERCENT = 99.5

export function isExternalAntigravityModel(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower.includes('claude') ||
    lower.includes('gpt') ||
    lower.includes('3p') ||
    lower.includes('external')
  )
}

export function formatStatusBarBucketLabel(
  name: string,
  provider: ProviderRateLimits['provider'],
  windowMinutes?: number
): string {
  if (provider === 'antigravity') {
    if (/gemini/i.test(name) || /^gm\b/i.test(name)) {
      if (/5h/i.test(name) || windowMinutes === 300) {
        return 'GM · 5H'
      }
      if (/weekly/i.test(name) || /wl\b/i.test(name) || windowMinutes === 10_080) {
        return 'GM · WL'
      }
      return 'GM · WL'
    }
  }
  return name
}

export function isVisibleStatusBarBucket(
  name: string,
  provider: ProviderRateLimits['provider']
): boolean {
  if (provider === 'antigravity') {
    return !isExternalAntigravityModel(name)
  }
  return STATUS_BAR_BUCKET_NAMES.has(name) || isCursorUsageBucket(name)
}

export function getAntigravityStatusTightestSection(p: ProviderRateLimits): UsageSection | null {
  const visible = (p.buckets ?? []).filter((b) => isVisibleStatusBarBucket(b.name, 'antigravity'))
  if (visible.length === 0) {
    return getTightestUsageSection(p)
  }
  const tightestBucket = visible.reduce((current, candidate) =>
    clampUsedPercent(candidate.usedPercent) > clampUsedPercent(current.usedPercent)
      ? candidate
      : current
  )
  return {
    label: formatStatusBarBucketLabel(
      tightestBucket.name,
      'antigravity',
      tightestBucket.windowMinutes
    ),
    window: tightestBucket
  }
}

// Why: only reveal the compact balance once a capped window can spend it.
export function isExtraUsageActive(p: ProviderRateLimits): boolean {
  if (
    !p.extraUsage ||
    !p.extraUsage.enabled ||
    (p.extraUsage.unit === 'currency' &&
      (p.extraUsage.balance === null || p.extraUsage.balance <= 0))
  ) {
    return false
  }
  return [p.session, p.weekly, p.monthly, p.fableWeekly].some(
    (w) => w != null && clampUsedPercent(w.usedPercent) >= CAP_THRESHOLD_PERCENT
  )
}

export function formatCompactExtraUsage(balance: ProviderRateLimits['extraUsage']): string {
  if (!balance) {
    return ''
  }
  if (balance.unit === 'credits') {
    return balance.unlimited
      ? translate('auto.components.status.bar.StatusBar.4025a6f62f', 'Unlimited')
      : translate('auto.components.status.bar.StatusBar.a95969101f', '{{value0}} credits', {
          value0: formatCreditCount(balance.balance)
        })
  }
  return balance.balance === null
    ? ''
    : translate('auto.components.status.bar.StatusBar.4fba7dc1e7', '{{value0}} bal', {
        value0: formatCurrencyAmount(balance.balance, balance.currencyCode)
      })
}
