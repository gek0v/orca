import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credential } from './native-account-test-fixtures'
import {
  createAntigravityFileCredentialBackend,
  createAntigravityHostCredentialBackend,
  isAntigravityFileStorageHost
} from './native-credential-backend'

vi.mock('./native-macos-credentials', () => ({
  readAntigravityMacOSCredential: vi.fn(),
  writeAntigravityMacOSCredential: vi.fn()
}))
vi.mock('./native-windows-credentials', () => ({
  readAntigravityWindowsCredential: vi.fn(),
  writeAntigravityWindowsCredential: vi.fn()
}))
import {
  readAntigravityWindowsCredential,
  writeAntigravityWindowsCredential
} from './native-windows-credentials'
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('execution-host native credential authority', () => {
  it('performs a real isolated file write/readback and detects a stale before-write credential', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-agy-backend-test-'))
    try {
      const path = join(dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
      const backend = createAntigravityFileCredentialBackend(path)
      await backend.write(credential('a'), null)
      expect((await backend.read())?.identity?.subject).toBe('a')
      await backend.write(credential('b'), credential('a'))
      expect(readFileSync(path, 'utf8')).toBe(credential('b'))
      await expect(backend.write(credential('a'), credential('a'))).rejects.toThrow(
        'changed during selection'
      )
      expect(readFileSync(path, 'utf8')).toBe(credential('b'))
      if (process.platform !== 'win32') {
        expect(statSync(path).mode & 0o077).toBe(0)
        chmodSync(path, 0o644)
        await expect(backend.read()).rejects.toThrow('read safely')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each(['SSH_TTY', 'SSH_CLIENT', 'SSH_CONNECTION', 'WSL_DISTRO_NAME', 'WSL_INTEROP'])(
    'uses the owning-host file bypass detector %s',
    (key) => {
      expect(isAntigravityFileStorageHost({ [key]: 'present' })).toBe(true)
      expect(isAntigravityFileStorageHost({ [key]: '' })).toBe(false)
    }
  )

  it('recognizes WSL kernel evidence and never guesses file mode from Linux alone', () => {
    expect(isAntigravityFileStorageHost({}, '6.6-microsoft-standard-WSL2')).toBe(true)
    expect(isAntigravityFileStorageHost({}, '6.8-linux')).toBe(false)
  })

  it('routes Windows hosts to Credential Manager instead of the file bypass', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { parseAntigravityNativeCredential } = await import('./native-credential-codec')
    let current: string | null = null
    vi.mocked(readAntigravityWindowsCredential).mockImplementation(async () =>
      current === null ? null : parseAntigravityNativeCredential(current)
    )
    vi.mocked(writeAntigravityWindowsCredential).mockImplementation(async (contents: string) => {
      current = contents
    })
    const backend = createAntigravityHostCredentialBackend('/task-home')
    expect(await backend.read()).toBeNull()
    await backend.write(credential('a'), null)
    expect(writeAntigravityWindowsCredential).toHaveBeenCalledWith(credential('a'))
  })

  it('capability-refuses unverified native linux without mutating client credentials', () => {
    for (const key of [
      'SSH_TTY',
      'SSH_CLIENT',
      'SSH_CONNECTION',
      'WSL_DISTRO_NAME',
      'WSL_INTEROP'
    ]) {
      vi.stubEnv(key, '')
    }
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    expect(() => createAntigravityHostCredentialBackend('/task-home')).toThrow(
      'not supported on this host yet'
    )
  })
})
