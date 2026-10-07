import { callAntigravityAccounts } from '@/runtime/runtime-antigravity-accounts-client'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import type {
  AntigravityAccountState,
  AntigravityAccountTarget
} from '../../../../shared/antigravity-account-types'
import type { ProviderRateLimits, RateLimitState } from '../../../../shared/rate-limit-types'

export async function refreshAllAntigravityAccountsUsage({
  owner,
  target,
  isMounted,
  onRefreshingAccountId,
  onStateUpdate,
  onAccountUsageUpdate
}: {
  owner: RuntimeClientTarget
  target: AntigravityAccountTarget
  isMounted: () => boolean
  onRefreshingAccountId: (id: string | null) => void
  onStateUpdate: (state: AntigravityAccountState) => void
  onAccountUsageUpdate: (accountId: string, limits: ProviderRateLimits) => void
}): Promise<AntigravityAccountState | null> {
  const before = await callAntigravityAccounts(owner, target, 'List')
  if (isMounted()) {
    onStateUpdate(before)
  }
  const accountsToRefresh = before.accounts
  if (accountsToRefresh.length === 0) {
    return before
  }

  const initialActiveId = before.activeAccountId
  let currentSelectedId = before.activeAccountId
  const ordered = [...accountsToRefresh].sort((a, b) => {
    if (a.id === initialActiveId) {
      return -1
    }
    if (b.id === initialActiveId) {
      return 1
    }
    return 0
  })

  for (const acc of ordered) {
    try {
      if (isMounted()) {
        onRefreshingAccountId(acc.id)
      }
      if (acc.id !== currentSelectedId) {
        const selectedState = await callAntigravityAccounts(owner, target, 'Select', acc.id)
        currentSelectedId = acc.id
        if (isMounted()) {
          onStateUpdate(selectedState)
        }
      }
      const snapshot = await callRuntimeRpc<{ rateLimits: RateLimitState }>(
        owner,
        'accounts.list',
        { refreshUsage: true }
      )
      const limits = snapshot.rateLimits?.antigravity
      if (isMounted() && limits) {
        onAccountUsageUpdate(acc.id, limits)
      }
    } catch (err) {
      console.warn(`Failed to refresh usage for account ${acc.id}:`, err)
    }
  }

  if (initialActiveId && currentSelectedId !== initialActiveId) {
    try {
      const restoredState = await callAntigravityAccounts(owner, target, 'Select', initialActiveId)
      if (isMounted()) {
        onStateUpdate(restoredState)
      }
    } catch {
      // Best-effort restoration
    }
  }

  const after = await callAntigravityAccounts(owner, target, 'List')
  if (isMounted()) {
    onStateUpdate(after)
  }
  return after
}
