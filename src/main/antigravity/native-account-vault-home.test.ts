import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secret-store'
import { createEncryptedAntigravityAccountStore } from './native-account-store'
import {
  getAntigravityAccountSessionPath,
  ensureAntigravityAccountSessionDir,
  resolveStructuredAntigravityAccountHomePath,
  syncAntigravityAccountCredentialsToSession
} from './native-account-vault-home'

import { credential } from './native-account-test-fixtures'
import { parseAntigravityNativeCredential } from './native-credential-codec'

describe('native-account-vault-home', () => {
  let tempVaultDir: string

  beforeEach(() => {
    tempVaultDir = mkdtempSync(join(tmpdir(), 'orca-ag-vault-test-'))
  })

  afterEach(() => {
    try {
      rmSync(tempVaultDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error
    }
    _resetSecretStoreForTests()
  })

  it('resolves account session path under vault sessions directory for an account id', () => {
    const sessionPath = getAntigravityAccountSessionPath(tempVaultDir, 'acc-123')
    expect(sessionPath).toBe(join(tempVaultDir, 'sessions', 'acc-123'))
  })

  it('ensures directory exists with proper permissions', () => {
    const sessionPath = getAntigravityAccountSessionPath(tempVaultDir, 'acc-work')
    expect(existsSync(sessionPath)).toBe(false)
    ensureAntigravityAccountSessionDir(sessionPath)
    expect(existsSync(sessionPath)).toBe(true)
  })

  it('prefers explicit GEMINI_ACP_HOME in launchEnv if provided', () => {
    const resolved = resolveStructuredAntigravityAccountHomePath({
      launchEnv: { GEMINI_ACP_HOME: '/custom/path' },
      vaultDir: tempVaultDir
    })
    expect(resolved).toBe('/custom/path')
  })

  it('resolves to account session path if ORCA_ANTIGRAVITY_ACCOUNT_ID is in launchEnv', () => {
    const resolved = resolveStructuredAntigravityAccountHomePath({
      launchEnv: { ORCA_ANTIGRAVITY_ACCOUNT_ID: 'acc-456' },
      vaultDir: tempVaultDir
    })
    expect(resolved).toBe(join(tempVaultDir, 'sessions', 'acc-456'))
  })

  it('resolves to active account session path if selectedAccountId is in vault store and no explicit account is given', () => {
    setSecretStore({
      isEncryptionAvailable: () => true,
      describeProtectionGap: () => null,
      encryptString: (value) => Buffer.from(`sealed:${Buffer.from(value).toString('base64')}`),
      decryptString: (value) => Buffer.from(value.toString().slice(7), 'base64').toString()
    })
    const vaultPath = join(tempVaultDir, 'vault')
    const store = createEncryptedAntigravityAccountStore(vaultPath)
    const cred = credential('user-sub')
    const parsed = parseAntigravityNativeCredential(cred)
    store.write({
      accounts: [
        {
          id: 'acc-active',
          email: 'user-sub@example.invalid',
          subject: 'user-sub',
          authMethod: parsed.authMethod,
          credentials: cred,
          createdAt: 1000,
          updatedAt: 1000
        }
      ],
      selectedAccountId: 'acc-active'
    })

    const resolved = resolveStructuredAntigravityAccountHomePath({
      launchEnv: {},
      vaultDir: tempVaultDir
    })
    expect(resolved).toBe(join(tempVaultDir, 'sessions', 'acc-active'))
  })

  it('falls back to default antigravity-acp home when no account or env variable is set', () => {
    const resolved = resolveStructuredAntigravityAccountHomePath({
      launchEnv: {},
      vaultDir: tempVaultDir,
      homePath: '/mock/home'
    })
    expect(resolved).toBe(join('/mock/home', '.gemini', 'antigravity-acp'))
  })

  it('syncs account credentials to session directory when resolveStructuredAntigravityAccountHomePath is called for known account', () => {
    setSecretStore({
      isEncryptionAvailable: () => true,
      describeProtectionGap: () => null,
      encryptString: (value) => Buffer.from(`sealed:${Buffer.from(value).toString('base64')}`),
      decryptString: (value) => Buffer.from(value.toString().slice(7), 'base64').toString()
    })
    const vaultPath = join(tempVaultDir, 'vault')
    const store = createEncryptedAntigravityAccountStore(vaultPath)
    const cred = credential('user-sync')
    const parsed = parseAntigravityNativeCredential(cred)
    store.write({
      accounts: [
        {
          id: 'acc-sync',
          email: 'user-sync@example.invalid',
          subject: 'user-sync',
          authMethod: parsed.authMethod,
          credentials: cred,
          createdAt: 1000,
          updatedAt: 1000
        }
      ],
      selectedAccountId: null
    })

    const resolved = resolveStructuredAntigravityAccountHomePath({
      launchEnv: {},
      vaultDir: tempVaultDir,
      accountId: 'acc-sync'
    })
    expect(resolved).toBe(join(tempVaultDir, 'sessions', 'acc-sync'))

    const rootTokenPath = join(resolved, 'antigravity-oauth-token')
    const cliTokenPath = join(resolved, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
    expect(existsSync(rootTokenPath)).toBe(true)
    expect(readFileSync(rootTokenPath, 'utf8')).toBe(cred)
    expect(existsSync(cliTokenPath)).toBe(true)
    expect(readFileSync(cliTokenPath, 'utf8')).toBe(cred)
  })

  it('syncAntigravityAccountCredentialsToSession writes credentials to root and cli session locations', () => {
    setSecretStore({
      isEncryptionAvailable: () => true,
      describeProtectionGap: () => null,
      encryptString: (value) => Buffer.from(`sealed:${Buffer.from(value).toString('base64')}`),
      decryptString: (value) => Buffer.from(value.toString().slice(7), 'base64').toString()
    })
    const vaultPath = join(tempVaultDir, 'vault')
    const store = createEncryptedAntigravityAccountStore(vaultPath)
    const cred = credential('user-direct')
    const parsed = parseAntigravityNativeCredential(cred)
    store.write({
      accounts: [
        {
          id: 'acc-direct',
          email: 'user-direct@example.invalid',
          subject: 'user-direct',
          authMethod: parsed.authMethod,
          credentials: cred,
          createdAt: 1000,
          updatedAt: 1000
        }
      ],
      selectedAccountId: null
    })

    const sessionDir = join(tempVaultDir, 'sessions', 'acc-direct')
    ensureAntigravityAccountSessionDir(sessionDir)
    syncAntigravityAccountCredentialsToSession(tempVaultDir, 'acc-direct', sessionDir)

    const rootTokenPath = join(sessionDir, 'antigravity-oauth-token')
    const cliTokenPath = join(sessionDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
    expect(existsSync(rootTokenPath)).toBe(true)
    expect(readFileSync(rootTokenPath, 'utf8')).toBe(cred)
    expect(existsSync(cliTokenPath)).toBe(true)
    expect(readFileSync(cliTokenPath, 'utf8')).toBe(cred)
  })

  it('syncAntigravityAccountCredentialsToSession handles missing vault or unknown account gracefully', () => {
    const sessionDir = join(tempVaultDir, 'sessions', 'acc-unknown')
    ensureAntigravityAccountSessionDir(sessionDir)

    expect(() => {
      syncAntigravityAccountCredentialsToSession(tempVaultDir, 'acc-unknown', sessionDir)
    }).not.toThrow()
    expect(existsSync(join(sessionDir, 'antigravity-oauth-token'))).toBe(false)
  })
})
