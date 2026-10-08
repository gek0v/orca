import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createEncryptedAntigravityAccountStore } from './native-account-store'

export function getAntigravityAccountVaultFilePath(vaultDir: string): string {
  return vaultDir.endsWith('vault') ? vaultDir : join(vaultDir, 'vault')
}

export function getAntigravityAccountSessionPath(vaultDir: string, accountId: string): string {
  const baseDir = vaultDir.endsWith('vault') ? dirname(vaultDir) : vaultDir
  return join(baseDir, 'sessions', accountId)
}

export function ensureAntigravityAccountSessionDir(sessionPath: string): void {
  if (!existsSync(sessionPath)) {
    mkdirSync(sessionPath, { recursive: true, mode: 0o700 })
  }
}

export function syncAntigravityAccountCredentialsToSession(
  vaultDir: string,
  accountId: string,
  sessionDir: string
): void {
  try {
    const vaultFile = getAntigravityAccountVaultFilePath(vaultDir)
    if (!existsSync(vaultFile)) {
      return
    }
    const store = createEncryptedAntigravityAccountStore(vaultFile)
    const { accounts } = store.read()
    const account = accounts.find((a) => a.id === accountId)
    if (account?.credentials) {
      const cliDir = join(sessionDir, '.gemini', 'antigravity-cli')
      if (!existsSync(cliDir)) {
        mkdirSync(cliDir, { recursive: true, mode: 0o700 })
      }
      writeFileSync(join(cliDir, 'antigravity-oauth-token'), account.credentials, {
        mode: 0o600,
        encoding: 'utf8'
      })
      writeFileSync(join(sessionDir, 'antigravity-oauth-token'), account.credentials, {
        mode: 0o600,
        encoding: 'utf8'
      })
    }
  } catch {
    // Best-effort safety on unreadable vault or write permissions
  }
}

export type ResolveAntigravityAccountHomeInput = {
  launchEnv: NodeJS.ProcessEnv
  vaultDir: string
  homePath?: string
  accountId?: string | null
}

export function resolveStructuredAntigravityAccountHomePath(
  input: ResolveAntigravityAccountHomeInput
): string {
  // 1. Explicit GEMINI_ACP_HOME in launch environment
  const envHome = input.launchEnv.GEMINI_ACP_HOME?.trim()
  if (envHome) {
    return envHome
  }

  // 2. Account ID from input, launch environment, or active selected account in store
  let targetAccountId = input.accountId ?? input.launchEnv.ORCA_ANTIGRAVITY_ACCOUNT_ID?.trim()
  if (!targetAccountId) {
    const vaultFile = getAntigravityAccountVaultFilePath(input.vaultDir)
    if (existsSync(vaultFile)) {
      try {
        const store = createEncryptedAntigravityAccountStore(vaultFile)
        targetAccountId = store.read().selectedAccountId ?? undefined
      } catch {
        // Vault unreadable or encryption unavailable; fall back to ambient home
      }
    }
  }

  if (targetAccountId) {
    const sessionDir = getAntigravityAccountSessionPath(input.vaultDir, targetAccountId)
    ensureAntigravityAccountSessionDir(sessionDir)
    syncAntigravityAccountCredentialsToSession(input.vaultDir, targetAccountId, sessionDir)
    return sessionDir
  }

  // 3. Ambient default home
  const baseHome = input.homePath ?? homedir()
  return join(baseHome, '.gemini', 'antigravity-acp')
}
