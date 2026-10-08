import { existsSync, lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { getSecretStore } from '../../shared/secret-store'
import { writeCredentialFileAtomic } from '../integration-credential-file'
import type { AntigravityAccountSummary } from '../../shared/antigravity-account-types'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { parseAntigravityNativeCredential } from './native-credential-codec'

export type StoredAntigravityAccount = AntigravityAccountSummary & { credentials: string }
export type AntigravityAccountVault = {
  accounts: StoredAntigravityAccount[]
  selectedAccountId: string | null
}
export type AntigravityAccountStore = {
  read(): AntigravityAccountVault
  write(vault: AntigravityAccountVault): void
  updateAccountUsage(accountId: string, usage: ProviderRateLimits, timestamp: number): void
}

const MAX_VAULT_BYTES = 4 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAccount(value: unknown): value is StoredAntigravityAccount {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    (value.email === null || typeof value.email === 'string') &&
    (value.subject === null || typeof value.subject === 'string') &&
    typeof value.authMethod === 'string' &&
    (value.alias === undefined || value.alias === null || typeof value.alias === 'string') &&
    (value.color === undefined || value.color === null || typeof value.color === 'string') &&
    (value.emoji === undefined || value.emoji === null || typeof value.emoji === 'string') &&
    (value.lastUsage === undefined || value.lastUsage === null || isRecord(value.lastUsage)) &&
    (value.lastUsageAt === undefined ||
      value.lastUsageAt === null ||
      typeof value.lastUsageAt === 'number') &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    typeof value.credentials === 'string'
  )
}

function requireProtection(): void {
  const secrets = getSecretStore()
  if (!secrets.isEncryptionAvailable() || secrets.describeProtectionGap() !== null) {
    throw new Error(
      'Protected secret storage is unavailable; Antigravity accounts were not changed.'
    )
  }
}

type VaultCacheEntry = {
  mtimeMs: number
  size: number
  vault: AntigravityAccountVault
}

const vaultCache = new Map<string, VaultCacheEntry>()

export function clearAntigravityAccountStoreCacheForTests(): void {
  vaultCache.clear()
}

export function createEncryptedAntigravityAccountStore(path: string): AntigravityAccountStore {
  return {
    read() {
      if (!existsSync(path)) {
        vaultCache.delete(path)
        return { accounts: [], selectedAccountId: null }
      }
      requireProtection()
      try {
        const stat = lstatSync(path)
        if (
          !stat.isFile() ||
          stat.size > MAX_VAULT_BYTES ||
          (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
        ) {
          throw new Error('unsafe vault')
        }
        const cached = vaultCache.get(path)
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
          return structuredClone(cached.vault)
        }
        const raw = readFileSync(path)
        let plaintext: string
        try {
          plaintext = getSecretStore().decryptString(raw)
        } catch (decryptError) {
          const asText = raw.toString('utf8').trim()
          if (asText.startsWith('{') && asText.endsWith('}')) {
            plaintext = asText
          } else {
            throw decryptError
          }
        }
        const value: unknown = JSON.parse(plaintext)
        if (
          !isRecord(value) ||
          !Array.isArray(value.accounts) ||
          !value.accounts.every(isAccount) ||
          (value.selectedAccountId !== null && typeof value.selectedAccountId !== 'string')
        ) {
          throw new Error('invalid vault')
        }
        const ids = new Set(value.accounts.map((account) => account.id))
        if (
          ids.size !== value.accounts.length ||
          (value.selectedAccountId !== null && !ids.has(value.selectedAccountId))
        ) {
          throw new Error('invalid selection')
        }
        for (const account of value.accounts) {
          const credential = parseAntigravityNativeCredential(account.credentials)
          if (
            credential.authMethod !== account.authMethod ||
            (credential.identity && credential.identity.subject !== account.subject)
          ) {
            throw new Error('inconsistent identity')
          }
        }
        const vault: AntigravityAccountVault = {
          accounts: value.accounts,
          selectedAccountId: value.selectedAccountId
        }
        vaultCache.set(path, {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          vault: structuredClone(vault)
        })
        return vault
      } catch {
        vaultCache.delete(path)
        throw new Error(
          'Antigravity account snapshots could not be read; the existing vault was preserved.'
        )
      }
    },
    write(vault) {
      requireProtection()
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      try {
        const encrypted = getSecretStore().encryptString(JSON.stringify(vault))
        if (encrypted.length > MAX_VAULT_BYTES) {
          throw new Error('vault exceeds readable size')
        }
        writeCredentialFileAtomic(path, encrypted)
        const newStat = statSync(path)
        if (process.platform !== 'win32' && (newStat.mode & 0o077) !== 0) {
          throw new Error('unsafe permissions')
        }
        vaultCache.set(path, {
          mtimeMs: newStat.mtimeMs,
          size: newStat.size,
          vault: structuredClone(vault)
        })
      } catch {
        vaultCache.delete(path)
        throw new Error('Antigravity account snapshots could not be saved.')
      }
    },
    updateAccountUsage(accountId, usage, timestamp) {
      const vault = this.read()
      const account = vault.accounts.find((a) => a.id === accountId)
      if (!account) {
        return
      }
      account.lastUsage = usage
      account.lastUsageAt = timestamp
      this.write(vault)
    }
  }
}
