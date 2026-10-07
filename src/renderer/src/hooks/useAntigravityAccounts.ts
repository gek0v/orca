import { useEffect, useState } from 'react'
import type {
  AntigravityAccountState,
  AntigravityAccountSummary
} from '../../../shared/antigravity-account-types'
import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import { callAntigravityAccounts } from '@/runtime/runtime-antigravity-accounts-client'
import { useAppStore } from '@/store'

let cachedState: AntigravityAccountState | null = null
const listeners = new Set<(state: AntigravityAccountState | null) => void>()

export function setCachedAntigravityAccountsState(nextState: AntigravityAccountState | null): void {
  if (cachedState && nextState) {
    const cachedAccounts = Array.isArray(cachedState.accounts) ? cachedState.accounts : []
    const nextAccounts = Array.isArray(nextState.accounts) ? nextState.accounts : []
    const cachedAccountsById = new Map(cachedAccounts.map((acc) => [acc.id, acc]))
    const mergedAccounts = nextAccounts.map((nextAcc) => {
      const cachedAcc = cachedAccountsById.get(nextAcc.id)
      if (
        cachedAcc?.lastUsage &&
        (nextAcc.lastUsage == null ||
          (cachedAcc.lastUsageAt &&
            (!nextAcc.lastUsageAt || cachedAcc.lastUsageAt > nextAcc.lastUsageAt)))
      ) {
        return {
          ...nextAcc,
          lastUsage: cachedAcc.lastUsage,
          lastUsageAt: cachedAcc.lastUsageAt
        }
      }
      return nextAcc
    })
    cachedState = {
      ...nextState,
      accounts: mergedAccounts
    }
  } else {
    cachedState = nextState
  }
  for (const listener of listeners) {
    listener(cachedState)
  }
}

export function getCachedAntigravityAccountsState(): AntigravityAccountState | null {
  return cachedState
}

export function subscribeAntigravityAccountsState(
  listener: (state: AntigravityAccountState | null) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function updateCachedAccountUsage(accountId: string, usage: ProviderRateLimits): void {
  if (!cachedState) {
    return
  }
  let updated = false
  const updatedAccounts = cachedState.accounts.map((acc) => {
    if (acc.id === accountId) {
      updated = true
      return {
        ...acc,
        lastUsage: usage,
        lastUsageAt: Date.now()
      }
    }
    return acc
  })
  if (updated) {
    cachedState = {
      ...cachedState,
      accounts: updatedAccounts
    }
    for (const listener of listeners) {
      listener(cachedState)
    }
  }
}

export function refreshAntigravityAccounts(): Promise<AntigravityAccountState> {
  return callAntigravityAccounts({ kind: 'local' }, { runtime: 'host' }, 'List').then((res) => {
    setCachedAntigravityAccountsState(res)
    return res
  })
}

export function useAntigravityAccounts(): {
  state: AntigravityAccountState | null
  accounts: AntigravityAccountSummary[]
  activeAccount: AntigravityAccountSummary | null
  getAccountById: (id: string) => AntigravityAccountSummary | null
} {
  const [state, setState] = useState<AntigravityAccountState | null>(cachedState)

  useEffect(() => {
    listeners.add(setState)
    if (!cachedState) {
      void refreshAntigravityAccounts().catch(() => {})
    }
    return () => {
      listeners.delete(setState)
    }
  }, [])

  const accounts = state?.accounts ?? []
  const activeAccount = accounts.find((a) => a.id === state?.activeAccountId) ?? null

  const getAccountById = (id: string) => {
    return accounts.find((a) => a.id === id) ?? null
  }

  return { state, accounts, activeAccount, getAccountById }
}

export function useActiveWindowAntigravityAccount(): AntigravityAccountSummary | null {
  const { activeAccount, getAccountById } = useAntigravityAccounts()
  const activeTabLaunchAccountId = useAppStore((s) => {
    if (!s.activeTabId) {
      return null
    }
    for (const tabs of Object.values(s.tabsByWorktree)) {
      const match = tabs.find((t) => t.id === s.activeTabId)
      if (match) {
        return match.launchAgent === 'antigravity' && match.launchAccountId
          ? match.launchAccountId
          : null
      }
    }
    return null
  })

  if (activeTabLaunchAccountId) {
    const tabAccount = getAccountById(activeTabLaunchAccountId)
    if (tabAccount) {
      return tabAccount
    }
  }

  return activeAccount
}
