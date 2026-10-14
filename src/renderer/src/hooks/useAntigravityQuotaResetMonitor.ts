import { useEffect, useMemo, useRef } from 'react'
import type { AntigravityAccountSummary } from '../../../../shared/antigravity-account-types'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { CodexStatusRuntimeTarget } from '@/components/status-bar/status-bar-runtime-targets'
import { useAntigravityAccounts } from './useAntigravityAccounts'
import { useResetCountdownClock } from './useResetCountdownClock'
import { switchAntigravityAccountAndRestartSession } from '@/lib/antigravity-session-restart'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

export type QuotaRecoveryCandidate = {
  accountId: string
  label: string
  resetsAt: number
  windowKey: 'session' | 'weekly'
}

export type QuotaRecoveryMonitorOptions = {
  activeTarget?: CodexStatusRuntimeTarget
  activeStrainedThresholdPercent?: number
  onRecoveryAlert?: (candidate: QuotaRecoveryCandidate) => void
}

export function isAccountStrained(
  limits: ProviderRateLimits | null | undefined,
  threshold = 80
): boolean {
  if (!limits || limits.status === 'error') {
    return true
  }
  if (limits.session && limits.session.usedPercent >= threshold) {
    return true
  }
  if (limits.buckets && limits.buckets.some((b) => b.usedPercent >= Math.max(threshold, 90))) {
    return true
  }
  return false
}

export function findRecoveredCandidates(
  accounts: AntigravityAccountSummary[],
  activeAccountId: string | null | undefined,
  now: number
): QuotaRecoveryCandidate[] {
  const candidates: QuotaRecoveryCandidate[] = []

  for (const acc of accounts) {
    if (acc.id === activeAccountId) {
      continue
    }
    const usage = acc.lastUsage
    if (!usage) {
      continue
    }
    const session = usage.session
    if (session?.resetsAt && session.resetsAt <= now) {
      const label = acc.alias?.trim() || acc.email || acc.id
      candidates.push({
        accountId: acc.id,
        label,
        resetsAt: session.resetsAt,
        windowKey: 'session'
      })
    }
  }

  candidates.sort((a, b) => a.resetsAt - b.resetsAt)
  return candidates
}

export function useAntigravityQuotaResetMonitor(options?: QuotaRecoveryMonitorOptions): {
  readyAccountIds: Set<string>
} {
  const { accounts, activeAccount } = useAntigravityAccounts()
  const notifiedPairsRef = useRef<Set<string>>(new Set())

  const trackedTimestamps = useMemo(() => {
    return accounts
      .map((acc) => acc.lastUsage?.session?.resetsAt)
      .filter((ts): ts is number => typeof ts === 'number' && ts > 0)
  }, [accounts])

  const now = useResetCountdownClock(trackedTimestamps)

  const readyAccountIds = useMemo(() => {
    const ready = new Set<string>()
    for (const acc of accounts) {
      const session = acc.lastUsage?.session
      if (session) {
        if ((session.resetsAt && session.resetsAt <= now) || session.usedPercent === 0) {
          ready.add(acc.id)
        }
      }
    }
    return ready
  }, [accounts, now])

  useEffect(() => {
    const candidates = findRecoveredCandidates(accounts, activeAccount?.id, now)
    const unnotified = candidates.filter(
      (c) => !notifiedPairsRef.current.has(`${c.accountId}:${c.resetsAt}`)
    )

    if (unnotified.length === 0) {
      return
    }

    // Always mark to prevent repeated triggers on re-render or sleep wake
    for (const c of unnotified) {
      notifiedPairsRef.current.add(`${c.accountId}:${c.resetsAt}`)
    }

    const activeStrained = isAccountStrained(
      activeAccount?.lastUsage,
      options?.activeStrainedThresholdPercent
    )

    if (!activeStrained) {
      return
    }

    // Pick top candidate (earliest reset)
    const bestCandidate = unnotified[0]
    options?.onRecoveryAlert?.(bestCandidate)

    toast.info(
      translate('accounts.antigravity.quotaRecovered', 'Quota recovered on {{account}}', {
        account: bestCandidate.label
      }),
      {
        description: translate(
          'accounts.antigravity.quotaRecoveredDesc',
          'Session quota is restored and ready to use.'
        ),
        action: {
          label: translate('common.switch', 'Switch'),
          onClick: () => {
            const target = options?.activeTarget ?? { runtime: 'host' }
            void switchAntigravityAccountAndRestartSession({
              targetAccountId: bestCandidate.accountId,
              target
            }).catch((err) => {
              console.error('Failed to switch to recovered Antigravity account:', err)
            })
          }
        },
        duration: 9000
      }
    )
  }, [accounts, activeAccount, now, options])

  return { readyAccountIds }
}
