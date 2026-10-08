import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  resolveAntigravityPlatformKey,
  resolveAntigravityBinaryName,
  resolveAntigravityAcpBinary,
  getAntigravityManagedInstallDir
} from './antigravity-runtime-manager'

describe('antigravity-runtime-manager', () => {
  let tempHome: string

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'orca-ag-runtime-test-'))
  })

  afterEach(() => {
    try {
      rmSync(tempHome, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error
    }
  })

  it('resolves current platform key correctly', () => {
    expect(resolveAntigravityPlatformKey('win32', 'x64')).toBe('windows-x86_64')
    expect(resolveAntigravityPlatformKey('win32', 'arm64')).toBe('windows-aarch64')
    expect(resolveAntigravityPlatformKey('linux', 'x64')).toBe('linux-x86_64')
    expect(resolveAntigravityPlatformKey('linux', 'arm64')).toBe('linux-aarch64')
    expect(resolveAntigravityPlatformKey('darwin', 'arm64')).toBe('darwin-aarch64')
    expect(resolveAntigravityPlatformKey('darwin', 'x64')).toBeNull()
  })

  it('resolves expected binary name for platform', () => {
    expect(resolveAntigravityBinaryName('win32')).toBe('agy_acp_server.exe')
    expect(resolveAntigravityBinaryName('linux')).toBe('agy_acp_server.par')
    expect(resolveAntigravityBinaryName('darwin')).toBe('agy_acp_server.par')
  })

  it('prefers AGY_ACP_BIN environment variable when pointing to existing binary', () => {
    const fakeBin = join(tempHome, 'custom-agy.exe')
    writeFileSync(fakeBin, 'mock')

    const result = resolveAntigravityAcpBinary({
      env: { AGY_ACP_BIN: fakeBin },
      homePath: tempHome,
      platform: 'win32'
    })

    expect(result).toEqual({
      command: fakeBin,
      source: 'env'
    })
  })

  it('finds managed binary under .local/opt/agy-acp/current', () => {
    const managedDir = getAntigravityManagedInstallDir(tempHome)
    mkdirSync(managedDir, { recursive: true })
    const binPath = join(managedDir, 'agy_acp_server.exe')
    writeFileSync(binPath, 'mock')

    const result = resolveAntigravityAcpBinary({
      env: {},
      homePath: tempHome,
      platform: 'win32'
    })

    expect(result).toEqual({
      command: binPath,
      source: 'managed'
    })
  })

  it('returns null when no candidate binary is installed', () => {
    const result = resolveAntigravityAcpBinary({
      env: {},
      homePath: tempHome,
      platform: 'win32'
    })

    expect(result).toBeNull()
  })
})
