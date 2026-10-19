import { getAntigravityAccountService } from '../../antigravity/native-account-host'
import { fetchAntigravityAccountRateLimits } from '../antigravity-usage-fetcher'
import type { ProviderRateLimits } from './service-types'

export type SyncAntigravityAccountsUsageOptions = {
  antigravityUsageEnabled?: boolean
}

export async function syncAntigravityAccountsUsage(
  antigravity: ProviderRateLimits,
  antigravityAccount: string | undefined,
  signal: AbortSignal,
  options?: SyncAntigravityAccountsUsageOptions
): Promise<void> {
  try {
    const service = getAntigravityAccountService({ runtime: 'host' })
    const state = await service.listAccounts()
    const usageEnabled = options?.antigravityUsageEnabled ?? true
    // Why: task pool accounts need fresh telemetry even when the status bar meter is hidden.
    const accountsToProbe = usageEnabled
      ? state.accounts
      : state.accounts.filter((acc) => acc.inTaskPool === true)

    if (accountsToProbe.length > 0) {
      for (const acc of accountsToProbe) {
        if (signal.aborted) {
          break
        }
        try {
          const usage = await fetchAntigravityAccountRateLimits({
            accountId: acc.id,
            signal
          })
          await service.recordUsageSnapshot(acc.id, usage)
        } catch {
          // Non-fatal per-account probe failure
        }
      }
    } else if (
      usageEnabled &&
      state.activeAccountId &&
      (!antigravityAccount || antigravityAccount === state.activeAccountId) &&
      antigravity.status === 'ok'
    ) {
      await service.recordUsageSnapshot(state.activeAccountId, antigravity)
    }
  } catch {
    // Non-fatal if host account service cannot be resolved
  }
}
