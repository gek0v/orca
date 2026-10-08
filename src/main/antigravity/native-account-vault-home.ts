import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export function getAntigravityAccountSessionPath(vaultDir: string, accountId: string): string {
  return join(vaultDir, 'sessions', accountId)
}

export function ensureAntigravityAccountSessionDir(sessionPath: string): void {
  if (!existsSync(sessionPath)) {
    mkdirSync(sessionPath, { recursive: true, mode: 0o700 })
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

  // 2. Account ID from input or launch environment
  const targetAccountId = input.accountId ?? input.launchEnv.ORCA_ANTIGRAVITY_ACCOUNT_ID?.trim()
  if (targetAccountId) {
    const sessionDir = getAntigravityAccountSessionPath(input.vaultDir, targetAccountId)
    ensureAntigravityAccountSessionDir(sessionDir)
    return sessionDir
  }

  // 3. Ambient default home
  const baseHome = input.homePath ?? homedir()
  return join(baseHome, '.gemini', 'antigravity-acp')
}
