import { getAntigravityAccountService } from '../../antigravity/native-account-host'
import { broadcastAntigravityAccountsChanged } from '../../ipc/antigravity-accounts-broadcast'
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
      await Promise.all(
        state.accounts.map(async (acc) => {
          try {
            const usage = await fetchAntigravityAccountRateLimits({ accountId: acc.id, signal })
            const nextState = await service.recordUsageSnapshot(acc.id, usage)
            if (nextState) {
              broadcastAntigravityAccountsChanged(nextState)
            }
          } catch {
            // Non-fatal per-account probe failure
          }
        })
      )
    } else if (
      state.activeAccountId &&
      (!antigravityAccount || antigravityAccount === state.activeAccountId) &&
      antigravity.status === 'ok'
    ) {
      const nextState = await service.recordUsageSnapshot(state.activeAccountId, antigravity)
      if (nextState) {
        broadcastAntigravityAccountsChanged(nextState)
      }
    }
  } catch {
    // Non-fatal if host account service cannot be resolved
  }
}
