import { getAntigravityAccountService } from '../../antigravity/native-account-host'
import { fetchAntigravityAccountRateLimits } from '../antigravity-usage-fetcher'
import type { ProviderRateLimits } from './service-types'

export async function syncAntigravityAccountsUsage(
  antigravity: ProviderRateLimits,
  antigravityAccount: string | undefined,
  signal: AbortSignal
): Promise<void> {
  try {
    const service = getAntigravityAccountService({ runtime: 'host' })
    const state = await service.listAccounts()
    if (state.accounts.length > 0) {
      for (const acc of state.accounts) {
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
