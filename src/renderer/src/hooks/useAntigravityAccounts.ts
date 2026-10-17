import { useEffect, useState } from 'react'
import type {
  AntigravityAccountState,
  AntigravityAccountSummary
} from '../../../shared/antigravity-account-types'
import type { Tab } from '../../../shared/tab-types'
import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
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

let inFlightRefresh: Promise<AntigravityAccountState> | null = null

export function refreshAntigravityAccounts(): Promise<AntigravityAccountState> {
  if (inFlightRefresh) {
    return inFlightRefresh
  }
  inFlightRefresh = callAntigravityAccounts({ kind: 'local' }, { runtime: 'host' }, 'List')
    .then((res) => {
      setCachedAntigravityAccountsState(res)
      return res
    })
    .finally(() => {
      inFlightRefresh = null
    })
  return inFlightRefresh
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

    const unsubscribeIpc =
      typeof window !== 'undefined'
        ? window.api?.antigravityAccounts?.onAccountsChanged?.((nextState) => {
            setCachedAntigravityAccountsState(nextState)
          })
        : undefined

    return () => {
      listeners.delete(setState)
      unsubscribeIpc?.()
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
  const targetAccountId = useAppStore((s) => {
    // 1. Tier 1: Focused split pane (s.activePaneId in unifiedTabsByWorktree and tabsByWorktree)
    if (s.activePaneId) {
      const activePaneIdStr = String(s.activePaneId)
      if (s.unifiedTabsByWorktree) {
        for (const tabs of Object.values(s.unifiedTabsByWorktree)) {
          const match = tabs.find(
            (t) =>
              String(t.id) === activePaneIdStr ||
              ('entityId' in t && String(t.entityId) === activePaneIdStr)
          )
          if (match) {
            if (match.launchAgent === 'antigravity' && match.launchAccountId) {
              return match.launchAccountId
            }
            break
          }
        }
      }
      if (s.tabsByWorktree) {
        for (const tabs of Object.values(s.tabsByWorktree)) {
          const match = tabs.find((t) => String(t.id) === activePaneIdStr)
          if (match) {
            if (match.launchAgent === 'antigravity' && match.launchAccountId) {
              return match.launchAccountId
            }
            break
          }
        }
      }
      if (s.sleepingAgentSessionsByPaneKey) {
        const paneKey = s.activeTabId ? `${s.activeTabId}:${activePaneIdStr}` : activePaneIdStr
        const session =
          s.sleepingAgentSessionsByPaneKey[paneKey] ??
          s.sleepingAgentSessionsByPaneKey[activePaneIdStr]
        if (session?.launchAccountId) {
          return session.launchAccountId
        }
      }
    }

    // 2. Tier 2: Active unified tab (s.unifiedTabsByWorktree / s.getTab(s.activeTabId))
    if (s.activeTabId) {
      let activeTab: Tab | null = null
      if (typeof s.getTab === 'function') {
        activeTab = s.getTab(s.activeTabId)
      }
      if (!activeTab && s.unifiedTabsByWorktree) {
        for (const tabs of Object.values(s.unifiedTabsByWorktree)) {
          const match = tabs.find((t) => t.id === s.activeTabId)
          if (match) {
            activeTab = match
            break
          }
        }
      }

      if (activeTab) {
        if (activeTab.launchAgent === 'antigravity' && activeTab.launchAccountId) {
          return activeTab.launchAccountId
        }

        // If the active tab is a split container, inspect its active child leaf
        const layout = s.terminalLayoutsByTabId?.[activeTab.id]
        if (layout?.activeLeafId) {
          const leafId = String(layout.activeLeafId)
          if (s.unifiedTabsByWorktree) {
            for (const tabs of Object.values(s.unifiedTabsByWorktree)) {
              const match = tabs.find(
                (t) => String(t.id) === leafId || ('entityId' in t && String(t.entityId) === leafId)
              )
              if (match?.launchAgent === 'antigravity' && match.launchAccountId) {
                return match.launchAccountId
              }
            }
          }
          if (s.tabsByWorktree) {
            for (const tabs of Object.values(s.tabsByWorktree)) {
              const match = tabs.find((t) => String(t.id) === leafId)
              if (match?.launchAgent === 'antigravity' && match.launchAccountId) {
                return match.launchAccountId
              }
            }
          }
          const sleeping =
            s.sleepingAgentSessionsByPaneKey?.[`${activeTab.id}:${leafId}`] ??
            s.sleepingAgentSessionsByPaneKey?.[leafId]
          if (sleeping?.launchAccountId) {
            return sleeping.launchAccountId
          }
        }
      }
    }

    // 3. Tier 3: Legacy tabs fallback
    if (s.activeTabId && s.tabsByWorktree) {
      for (const tabs of Object.values(s.tabsByWorktree)) {
        const match = tabs.find((t) => t.id === s.activeTabId)
        if (match) {
          if (match.launchAgent === 'antigravity' && match.launchAccountId) {
            return match.launchAccountId
          }
          break
        }
      }
    }

    // 4. Tier 4: Workspace repo binding or global default
    const repoId = s.activeWorktreeId ? getRepoIdFromWorktreeId(s.activeWorktreeId) : s.activeRepoId
    if (repoId && s.repos) {
      const repo = s.repos.find((r) => r.id === repoId || r.id === s.activeRepoId)
      if (repo?.antigravityAccountId) {
        return repo.antigravityAccountId
      }
    }

    return null
  })

  if (targetAccountId) {
    const tabAccount = getAccountById(targetAccountId)
    if (tabAccount) {
      return tabAccount
    }
  }

  return activeAccount
}
