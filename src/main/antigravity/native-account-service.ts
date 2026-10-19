import { randomUUID } from 'node:crypto'
import type {
  AntigravityAccountState,
  AntigravityAccountSummary
} from '../../shared/antigravity-account-types'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  matchesAntigravityCredential as matches,
  parseAntigravityNativeCredential,
  type AntigravityNativeCredential
} from './native-credential-codec'
import { broadcastAntigravityAccountsChanged } from '../ipc/antigravity-accounts-broadcast'
import {
  ensureAntigravityAccountProfile,
  removeAntigravityAccountProfile
} from './native-account-profile-manager'
import type { AntigravityAccountStore, AntigravityAccountVault } from './native-account-store'

export type AntigravityAccountServiceOptions = {
  homeDir?: string
  ensureProfile?: (accountId: string, credentialsJson: string) => void
  removeProfile?: (accountId: string) => void
}

import type { AntigravityCredentialBackend } from './native-credential-backend'
export type { AntigravityCredentialBackend }

export class AntigravityAccountService {
  private mutation: Promise<unknown> = Promise.resolve()
  private readonly ensureProfile: (accountId: string, credentialsJson: string) => void
  private readonly removeProfile: (accountId: string) => void

  constructor(
    private readonly store: AntigravityAccountStore,
    private readonly backend: AntigravityCredentialBackend,
    private readonly now: () => number = Date.now,
    private readonly broadcast: (
      state: AntigravityAccountState
    ) => void = broadcastAntigravityAccountsChanged,
    options?: AntigravityAccountServiceOptions
  ) {
    const homeDir = options?.homeDir
    this.ensureProfile =
      options?.ensureProfile ??
      ((accountId, credentialsJson) =>
        ensureAntigravityAccountProfile(accountId, credentialsJson, {
          homeDir
        }))
    this.removeProfile =
      options?.removeProfile ??
      ((accountId) => removeAntigravityAccountProfile(accountId, { homeDir }))
  }

  listAccounts(): Promise<AntigravityAccountState> {
    return this.serialize(async () => this.state(await this.reconcile()))
  }

  addCurrentAccount(): Promise<AntigravityAccountState> {
    return this.serialize(async () => {
      const { vault, current } = await this.reconcile()
      if (!current) {
        throw new Error('Sign in with agy on this execution host, then save the current account.')
      }
      if (!current.identity) {
        throw new Error(
          'The current Antigravity credential has no stable Google identity; it cannot be saved for switching.'
        )
      }
      let account = vault.accounts.find((entry) => matches(entry, current))
      if (!account) {
        const timestamp = this.now()
        account = {
          id: randomUUID(),
          email: current.identity.email,
          subject: current.identity.subject,
          authMethod: current.authMethod,
          credentials: current.contents,
          createdAt: timestamp,
          updatedAt: timestamp
        }
        vault.accounts.push(account)
        this.store.write(vault)
      }
      this.ensureProfile(account.id, account.credentials)
      const nextState = this.state({ vault, current })
      this.broadcast(nextState)
      return nextState
    })
  }

  selectAccount(id: string): Promise<AntigravityAccountState> {
    return this.serialize(async () => {
      const { vault, current } = await this.reconcile()
      const selected = vault.accounts.find((account) => account.id === id)
      if (!selected) {
        throw new Error('Antigravity account was not found.')
      }
      parseAntigravityNativeCredential(selected.credentials)
      if (!current || !matches(selected, current)) {
        await this.backend.write(selected.credentials, current?.contents ?? null)
      }
      const readback = await this.backend.read()
      if (!readback || !matches(selected, readback)) {
        throw new Error(
          'Antigravity account switching could not be verified; refresh before retrying.'
        )
      }
      const latest = this.store.read()
      if (!latest.accounts.some((account) => account.id === id && matches(account, readback))) {
        throw new Error('Antigravity snapshots changed during selection; refresh before retrying.')
      }
      latest.selectedAccountId = id
      this.updateSnapshot(latest, readback)
      this.store.write(latest)
      this.ensureProfile(selected.id, selected.credentials)
      const nextState = this.state({ vault: latest, current: readback })
      this.broadcast(nextState)
      return nextState
    })
  }

  removeAccount(id: string): Promise<AntigravityAccountState> {
    return this.serialize(async () => {
      const { vault, current } = await this.reconcile()
      const account = vault.accounts.find((entry) => entry.id === id)
      if (!account) {
        throw new Error('Antigravity account was not found.')
      }
      const cannotRemove = (
        acc: typeof account,
        sel: string | null,
        active: AntigravityNativeCredential | null
      ) => sel === id || (active !== null && matches(acc, active))
      if (cannotRemove(account, vault.selectedAccountId, current)) {
        throw new Error('Select another Antigravity account before removing this account.')
      }
      const readback = await this.backend.read()
      const latest = this.store.read()
      const latestAccount = latest.accounts.find((entry) => entry.id === id)
      if (!latestAccount) {
        throw new Error('Antigravity account snapshots changed; refresh before retrying.')
      }
      if (cannotRemove(latestAccount, latest.selectedAccountId, readback)) {
        throw new Error('Select another Antigravity account before removing this account.')
      }
      if (readback) {
        this.updateSnapshot(latest, readback)
      }
      latest.accounts = latest.accounts.filter((entry) => entry.id !== id)
      this.store.write(latest)
      this.removeProfile(id)
      const nextState = this.state({ vault: latest, current: readback })
      this.broadcast(nextState)
      return nextState
    })
  }

  updateAccountMetadata(
    id: string,
    metadata: {
      alias?: string | null
      color?: string | null
      emoji?: string | null
    }
  ): Promise<AntigravityAccountState> {
    return this.serialize(async () => {
      const { vault, current } = await this.reconcile()
      const account = vault.accounts.find((entry) => entry.id === id)
      if (!account) {
        throw new Error('Antigravity account was not found.')
      }
      for (const key of ['alias', 'color', 'emoji'] as const) {
        if (metadata[key] !== undefined) {
          account[key] = metadata[key]?.trim() || null
        }
      }
      account.updatedAt = this.now()
      this.store.write(vault)
      const nextState = this.state({ vault, current })
      this.broadcast(nextState)
      return nextState
    })
  }

  setAccountPoolMembership(accountId: string, inPool: boolean): Promise<AntigravityAccountSummary> {
    return this.serialize(async () => {
      const { vault, current } = await this.reconcile()
      const account = vault.accounts.find((entry) => entry.id === accountId)
      if (!account) {
        throw new Error('Antigravity account was not found.')
      }
      account.inTaskPool = inPool
      account.updatedAt = this.now()
      this.store.write(vault)
      const nextState = this.state({ vault, current })
      this.broadcast(nextState)
      const summary = nextState.accounts.find((entry) => entry.id === accountId)
      if (!summary) {
        throw new Error('Antigravity account was not found.')
      }
      return summary
    })
  }

  recordUsageSnapshot(
    accountId: string,
    usage: ProviderRateLimits
  ): Promise<AntigravityAccountState> {
    return this.serialize(async () => {
      const { vault, current } = await this.reconcile()
      const account = vault.accounts.find((entry) => entry.id === accountId)
      if (!account) {
        return this.state({ vault, current })
      }
      account.lastUsage = usage
      account.lastUsageAt = this.now()
      this.store.write(vault)
      const nextState = this.state({ vault, current })
      this.broadcast(nextState)
      return nextState
    })
  }

  prepareForLaunch(): Promise<void> {
    return this.serialize(async () => {
      const { vault, current } = await this.reconcile()
      if (!vault.selectedAccountId) {
        return
      }
      const selected = vault.accounts.find((account) => account.id === vault.selectedAccountId)
      if (selected && current && matches(selected, current)) {
        return
      }
      if (current) {
        const matching = vault.accounts.find((entry) => matches(entry, current))
        if (matching) {
          vault.selectedAccountId = matching.id
          this.store.write(vault)
          return
        }
      }
      if (!selected) {
        vault.selectedAccountId = null
        this.store.write(vault)
        return
      }
      throw new Error(
        'The native Antigravity account changed. Select the account again in Accounts before launching agy.'
      )
    })
  }

  private async reconcile() {
    const current = await this.backend.read()
    // Re-read after native I/O so a delayed read never restores an older vault.
    const vault = this.store.read()
    if (current && this.updateSnapshot(vault, current)) {
      this.store.write(vault)
      this.broadcast(this.state({ vault, current }))
    }
    return { vault, current }
  }

  private updateSnapshot(
    vault: AntigravityAccountVault,
    current: AntigravityNativeCredential
  ): boolean {
    const account = vault.accounts.find((entry) => matches(entry, current))
    if (!account || account.credentials === current.contents) {
      return false
    }
    account.credentials = current.contents
    account.email = current.identity?.email ?? account.email
    account.updatedAt = this.now()
    this.ensureProfile(account.id, account.credentials)
    return true
  }

  private state({
    vault,
    current
  }: {
    vault: AntigravityAccountVault
    current: AntigravityNativeCredential | null
  }): AntigravityAccountState {
    const active = current ? vault.accounts.find((entry) => matches(entry, current)) : null
    return {
      accounts: vault.accounts.map(({ credentials: _credentials, ...account }) => account),
      activeAccountId: active?.id ?? null,
      selectedAccountId: vault.selectedAccountId,
      currentAccount: current
        ? {
            email: current.identity?.email ?? null,
            subject: current.identity?.subject ?? null,
            authMethod: current.authMethod,
            identityKnown: current.identity !== null
          }
        : null
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(operation, operation)
    this.mutation = next.catch(() => undefined)
    return next
  }
}
