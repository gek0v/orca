import { useEffect, useState } from 'react'
import type { AntigravityAccountState, AntigravityAccountSummary } from '../../../shared/antigravity-account-types'
import { callAntigravityAccounts } from '@/runtime/runtime-antigravity-accounts-client'

let cachedState: AntigravityAccountState | null = null
const listeners = new Set<(state: AntigravityAccountState | null) => void>()

export function setCachedAntigravityAccountsState(state: AntigravityAccountState | null): void {
  cachedState = state
  for (const listener of listeners) {
    listener(cachedState)
  }
}

export function refreshAntigravityAccounts(): Promise<AntigravityAccountState> {
  return callAntigravityAccounts({ kind: 'local' }, { runtime: 'host' }, 'List').then(
    (res) => {
      setCachedAntigravityAccountsState(res)
      return res
    }
  )
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
