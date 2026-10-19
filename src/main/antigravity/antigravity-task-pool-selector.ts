import type { AntigravityAccountRecord } from '../../shared/antigravity-account-types'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'

export type TaskPoolSelectionResult = {
  accountId: string
  headroom: number
}

export type TaskPoolSelectionOptions = {
  vault: { accounts: readonly AntigravityAccountRecord[]; selectedAccountId?: string | null }
  getRateLimits: (accountId: string) => ProviderRateLimits | null | undefined
  onTriggerProbe?: (accountId: string) => void
}

type AccountCandidate = {
  account: AntigravityAccountRecord
  headroom: number
}

export function selectAntigravityPoolAccount(
  options: TaskPoolSelectionOptions
): TaskPoolSelectionResult {
  const poolAccounts = options.vault.accounts.filter((account) => account.inTaskPool === true)
  if (poolAccounts.length === 0) {
    throw new OrchestrationError(
      'invalid_argument',
      'No Antigravity accounts are configured in the Task Pool. Enable at least one account in Settings > Accounts.'
    )
  }

  const candidates: AccountCandidate[] = []
  const resetCandidates: number[] = []

  for (const account of poolAccounts) {
    const rateLimits = options.getRateLimits(account.id)

    if (rateLimits == null) {
      options.onTriggerProbe?.(account.id)
      candidates.push({ account, headroom: 100 })
      continue
    }

    const status: string = rateLimits.status
    const failureKind: string | undefined = rateLimits.usageMetadata?.failureKind
    const isRateLimited = status === 'rate-limited' || failureKind === 'rate-limited'

    const usedSession = rateLimits.session?.usedPercent ?? 0
    const usedWeekly = rateLimits.weekly?.usedPercent ?? 0

    const sessionExhausted = usedSession >= 100
    const weeklyExhausted = usedWeekly >= 100

    if (
      sessionExhausted &&
      typeof rateLimits.session?.resetsAt === 'number' &&
      rateLimits.session.resetsAt > 0
    ) {
      resetCandidates.push(rateLimits.session.resetsAt)
    }
    if (
      weeklyExhausted &&
      typeof rateLimits.weekly?.resetsAt === 'number' &&
      rateLimits.weekly.resetsAt > 0
    ) {
      resetCandidates.push(rateLimits.weekly.resetsAt)
    }
    if (isRateLimited) {
      if (typeof rateLimits.session?.resetsAt === 'number' && rateLimits.session.resetsAt > 0) {
        resetCandidates.push(rateLimits.session.resetsAt)
      }
      if (typeof rateLimits.weekly?.resetsAt === 'number' && rateLimits.weekly.resetsAt > 0) {
        resetCandidates.push(rateLimits.weekly.resetsAt)
      }
      if (
        typeof rateLimits.usageMetadata?.retryAtMs === 'number' &&
        rateLimits.usageMetadata.retryAtMs > 0
      ) {
        resetCandidates.push(rateLimits.usageMetadata.retryAtMs)
      }
    }

    if (isRateLimited || sessionExhausted || weeklyExhausted) {
      continue
    }

    const headroom = Math.min(100 - usedSession, 100 - usedWeekly)
    if (headroom <= 0) {
      continue
    }

    candidates.push({ account, headroom })
  }

  if (candidates.length === 0) {
    const earliestReset = resetCandidates.length > 0 ? Math.min(...resetCandidates) : undefined
    const formatted = earliestReset !== undefined ? new Date(earliestReset).toISOString() : null
    const message = formatted
      ? `All accounts in the Antigravity Task Pool have reached their usage limits. Earliest reset at: ${formatted}.`
      : 'All accounts in the Antigravity Task Pool have reached their usage limits.'

    throw new OrchestrationError(
      'resource_exhausted',
      message,
      earliestReset !== undefined ? { resetsAt: earliestReset } : undefined
    )
  }

  candidates.sort((a, b) => {
    if (b.headroom !== a.headroom) {
      return b.headroom - a.headroom
    }
    const lastUsedA = a.account.lastUsedAt ?? a.account.lastUsageAt ?? 0
    const lastUsedB = b.account.lastUsedAt ?? b.account.lastUsageAt ?? 0
    return lastUsedA - lastUsedB
  })

  const winner = candidates[0]
  if (!winner) {
    throw new OrchestrationError(
      'resource_exhausted',
      'All accounts in the Antigravity Task Pool have reached their usage limits.'
    )
  }

  return {
    accountId: winner.account.id,
    headroom: winner.headroom
  }
}
