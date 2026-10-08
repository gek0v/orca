import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import type { runProcess } from '../../../shared/child-process/run-process'
import {
  ANTIGRAVITY_PLATFORM_CATALOG,
  resolveAntigravityPlatformKey,
  resolveAntigravityBinaryName,
  resolveAntigravityAcpBinary,
  clearAntigravityAcpBinaryCacheForTests,
  getAntigravityManagedInstallDir,
  installAntigravityAcpRuntime,
  ensureAntigravityAcpRuntime
} from './antigravity-runtime-manager'

describe('antigravity-runtime-manager', () => {
  let tempHome: string

  beforeEach(() => {
    clearAntigravityAcpBinaryCacheForTests()
    tempHome = mkdtempSync(join(tmpdir(), 'orca-ag-runtime-test-'))
  })

  afterEach(() => {
    clearAntigravityAcpBinaryCacheForTests()
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

  it('finds binary under AppData/Local/agy/bin on Windows', () => {
    const appDataBinDir = join(tempHome, 'AppData', 'Local', 'agy', 'bin')
    mkdirSync(appDataBinDir, { recursive: true })
    const binPath = join(appDataBinDir, 'agy_acp_server.exe')
    writeFileSync(binPath, 'mock')

    const result = resolveAntigravityAcpBinary({
      env: {},
      homePath: tempHome,
      platform: 'win32'
    })

    expect(result).toEqual({
      command: binPath,
      source: 'user-bin'
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

  it('installs runtime with checksum verification and mock extraction', async () => {
    const fakeContent = 'mock-zip-binary-data'
    const fakeHash = createHash('sha256').update(fakeContent).digest('hex')

    const testCatalogArtifact = ANTIGRAVITY_PLATFORM_CATALOG['windows-x86_64']
    const originalHash = testCatalogArtifact.archiveSha256
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mutating catalog entry for isolated test
    ;(testCatalogArtifact as { archiveSha256: string }).archiveSha256 = fakeHash

    try {
      const mockFetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(fakeContent))
            controller.close()
          }
        })
      }))

      const mockRunProcess = vi.fn(async () => {
        const managedDir = getAntigravityManagedInstallDir(tempHome)
        mkdirSync(managedDir, { recursive: true })
        writeFileSync(join(managedDir, 'agy_acp_server.exe'), 'extracted-binary')
        return { code: 0, stdout: '', stderr: '', timedOut: false }
      })

      const bin = await installAntigravityAcpRuntime({
        homePath: tempHome,
        platform: 'win32',
        arch: 'x64',
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mock fetch implementation
        fetchImpl: mockFetch as unknown as typeof fetch,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mock runProcess implementation
        runProcessImpl: mockRunProcess as unknown as typeof runProcess
      })

      expect(bin).toBe(join(getAntigravityManagedInstallDir(tempHome), 'agy_acp_server.exe'))
      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(mockRunProcess).toHaveBeenCalledTimes(1)
    } finally {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: restore original hash
      ;(testCatalogArtifact as { archiveSha256: string }).archiveSha256 = originalHash
    }
  })

  it('rejects installation when checksum does not match', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('corrupted-data'))
          controller.close()
        }
      })
    }))

    await expect(
      installAntigravityAcpRuntime({
        homePath: tempHome,
        platform: 'win32',
        arch: 'x64',
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mock fetch implementation
        fetchImpl: mockFetch as unknown as typeof fetch
      })
    ).rejects.toThrow(/Checksum mismatch/)
  })

  it('ensureAntigravityAcpRuntime returns existing binary without downloading', async () => {
    const managedDir = getAntigravityManagedInstallDir(tempHome)
    mkdirSync(managedDir, { recursive: true })
    const binPath = join(managedDir, 'agy_acp_server.exe')
    writeFileSync(binPath, 'existing')

    const mockFetch = vi.fn()
    const result = await ensureAntigravityAcpRuntime({
      homePath: tempHome,
      platform: 'win32',
      arch: 'x64',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mock fetch implementation
      fetchImpl: mockFetch as unknown as typeof fetch
    })

    expect(result).toBe(binPath)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('caches resolution result and does not re-query filesystem candidates on consecutive calls', () => {
    const input = {
      env: {},
      homePath: tempHome,
      platform: 'win32' as const
    }

    expect(resolveAntigravityAcpBinary(input)).toBeNull()

    const managedDir = getAntigravityManagedInstallDir(tempHome)
    mkdirSync(managedDir, { recursive: true })
    const binPath = join(managedDir, 'agy_acp_server.exe')
    writeFileSync(binPath, 'mock-binary')

    // Consecutive call with same input returns cached null instead of detecting the new file on disk
    expect(resolveAntigravityAcpBinary(input)).toBeNull()

    clearAntigravityAcpBinaryCacheForTests()

    // After clearing cache, re-queries filesystem and discovers the binary
    expect(resolveAntigravityAcpBinary(input)).toEqual({
      command: binPath,
      source: 'managed'
    })

    // Consecutive call returns the cached found resolution
    expect(resolveAntigravityAcpBinary(input)).toEqual({
      command: binPath,
      source: 'managed'
    })
  })

  it('returns cached result on consecutive calls with empty input', () => {
    const first = resolveAntigravityAcpBinary()
    const second = resolveAntigravityAcpBinary()
    expect(first).toBe(second)
  })

  it('invalidates binary cache when runtime is installed', async () => {
    const input = {
      env: {},
      homePath: tempHome,
      platform: 'win32' as const
    }

    expect(resolveAntigravityAcpBinary(input)).toBeNull()

    const fakeContent = 'mock-zip-binary-data'
    const fakeHash = createHash('sha256').update(fakeContent).digest('hex')
    const testCatalogArtifact = ANTIGRAVITY_PLATFORM_CATALOG['windows-x86_64']
    const originalHash = testCatalogArtifact.archiveSha256
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mutating catalog entry for isolated test
    ;(testCatalogArtifact as { archiveSha256: string }).archiveSha256 = fakeHash

    try {
      const mockFetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(fakeContent))
            controller.close()
          }
        })
      }))

      const mockRunProcess = vi.fn(async () => {
        const managedDir = getAntigravityManagedInstallDir(tempHome)
        mkdirSync(managedDir, { recursive: true })
        writeFileSync(join(managedDir, 'agy_acp_server.exe'), 'extracted-binary')
        return { code: 0, stdout: '', stderr: '', timedOut: false }
      })

      await installAntigravityAcpRuntime({
        homePath: tempHome,
        platform: 'win32',
        arch: 'x64',
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mock fetch implementation
        fetchImpl: mockFetch as unknown as typeof fetch,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mock runProcess implementation
        runProcessImpl: mockRunProcess as unknown as typeof runProcess
      })

      // Cache was cleared by installAntigravityAcpRuntime, so next resolution finds the installed binary
      expect(resolveAntigravityAcpBinary(input)).toEqual({
        command: join(getAntigravityManagedInstallDir(tempHome), 'agy_acp_server.exe'),
        source: 'managed'
      })
    } finally {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: restore original hash
      ;(testCatalogArtifact as { archiveSha256: string }).archiveSha256 = originalHash
    }
  })
})
