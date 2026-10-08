import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  getAntigravityAccountSessionPath,
  ensureAntigravityAccountSessionDir,
  resolveStructuredAntigravityAccountHomePath
} from './native-account-vault-home'

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

  it('falls back to default antigravity-acp home when no account or env variable is set', () => {
    const resolved = resolveStructuredAntigravityAccountHomePath({
      launchEnv: {},
      vaultDir: tempVaultDir,
      homePath: '/mock/home'
    })
    expect(resolved).toBe(join('/mock/home', '.gemini', 'antigravity-acp'))
  })
})
