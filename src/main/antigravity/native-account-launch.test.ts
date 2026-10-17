import { beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { prepareAntigravityAccountForLaunch } from './native-account-launch'
import { createEncryptedAntigravityAccountStore } from './native-account-store'
import { getAntigravityAccountService } from './native-account-host'

const {
  prepareForLaunch,
  selectAccount,
  ensureAntigravityAccountProfile,
  writeAntigravityWindowsCredential
} = vi.hoisted(() => ({
  prepareForLaunch: vi.fn(),
  selectAccount: vi.fn(),
  ensureAntigravityAccountProfile: vi.fn(),
  writeAntigravityWindowsCredential: vi.fn()
}))
vi.mock('node:fs', () => ({ existsSync: vi.fn() }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => '/task/home' })
}))
vi.mock('./native-account-store', () => ({ createEncryptedAntigravityAccountStore: vi.fn() }))
vi.mock('./native-account-host', () => ({
  getAntigravityAccountVaultPath: () => '/task/vault',
  getAntigravityAccountService: vi.fn(() => ({ prepareForLaunch, selectAccount }))
}))
vi.mock('./native-account-profile-manager', () => ({
  ensureAntigravityAccountProfile
}))
vi.mock('./native-windows-credentials', () => ({
  writeAntigravityWindowsCredential,
  readAntigravityWindowsCredential: vi.fn()
}))

beforeEach(() => {
  vi.mocked(existsSync).mockReset().mockReturnValue(true)
  vi.mocked(getAntigravityAccountService).mockClear()
  vi.mocked(createEncryptedAntigravityAccountStore).mockReturnValue({
    read: () => ({ accounts: [], selectedAccountId: 'selected' }),
    write: vi.fn(),
    updateAccountUsage: vi.fn()
  })
  prepareForLaunch.mockReset().mockResolvedValue(undefined)
  selectAccount.mockReset().mockResolvedValue(undefined)
  writeAntigravityWindowsCredential.mockReset().mockResolvedValue(undefined)
  ensureAntigravityAccountProfile.mockReset().mockImplementation((accountId: string) => ({
    accountId,
    profileDir: `/task/profiles/${accountId}`,
    cliDir: `/task/profiles/${accountId}/.gemini/antigravity-cli`,
    tokenPath: `/task/profiles/${accountId}/.gemini/antigravity-cli/antigravity-oauth-token`,
    envPatch: {
      ANTIGRAVITY_PROFILE_DIR: `/task/profiles/${accountId}/.gemini/antigravity-cli`,
      USERPROFILE: `/task/profiles/${accountId}`,
      HOME: `/task/profiles/${accountId}`,
      SSH_CLIENT: '127.0.0.1 0 0'
    }
  }))
})

describe('native account verification before agy launch', () => {
  it('checks the selected native account before a new host agy launch', async () => {
    await prepareAntigravityAccountForLaunch({
      launchAgent: 'antigravity',
      env: { HOME: '/task/home' }
    })
    expect(prepareForLaunch).toHaveBeenCalledOnce()
  })

  it('recognizes the ordinary agy executable through the shared command recognizer', async () => {
    await prepareAntigravityAccountForLaunch({
      command: 'agy --conversation synthetic',
      env: { HOME: '/task/home' }
    })
    expect(prepareForLaunch).toHaveBeenCalledOnce()
  })

  it('preserves owning-host and distro boundaries without reading client credentials', async () => {
    await prepareAntigravityAccountForLaunch({
      launchAgent: 'antigravity',
      connectionId: 'ssh-owner'
    })
    await prepareAntigravityAccountForLaunch({ launchAgent: 'antigravity', isWsl: true })
    await prepareAntigravityAccountForLaunch({ launchAgent: 'codex' })
    expect(existsSync).not.toHaveBeenCalled()
    expect(getAntigravityAccountService).not.toHaveBeenCalled()
  })

  it('does not read native credentials when no account selection exists', async () => {
    vi.mocked(existsSync).mockReturnValue(false)
    await prepareAntigravityAccountForLaunch({ launchAgent: 'antigravity' })
    expect(getAntigravityAccountService).not.toHaveBeenCalled()
  })

  it('blocks a launch using an overridden credential home without silently replacing its account', async () => {
    await expect(
      prepareAntigravityAccountForLaunch({
        launchAgent: 'antigravity',
        env: { HOME: '/other/authority' }
      })
    ).rejects.toThrow('different credential authority')
    expect(prepareForLaunch).not.toHaveBeenCalled()
  })

  it('propagates failed native identity verification so the PTY cannot launch as another account', async () => {
    prepareForLaunch.mockRejectedValue(new Error('native identity changed'))
    await expect(
      prepareAntigravityAccountForLaunch({
        launchAgent: 'antigravity',
        env: { HOME: '/task/home' }
      })
    ).rejects.toThrow('native identity changed')
  })

  it('rejects deleting the credential home before launch', async () => {
    await expect(
      prepareAntigravityAccountForLaunch({ launchAgent: 'antigravity', envToDelete: ['HOME'] })
    ).rejects.toThrow('different credential authority')
    expect(prepareForLaunch).not.toHaveBeenCalled()
  })

  it('does not merge removed authority detectors back into a complete launch environment', async () => {
    vi.stubEnv('SSH_CLIENT', 'task-host')
    try {
      await expect(
        prepareAntigravityAccountForLaunch({
          launchAgent: 'antigravity',
          env: { HOME: '/task/home' },
          envIsComplete: true
        })
      ).rejects.toThrow('different credential authority')
      expect(prepareForLaunch).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('configures independent profile environments concurrently without mutating the OS keyring (Review Focus #1)', async () => {
    vi.mocked(createEncryptedAntigravityAccountStore).mockReturnValue({
      read: () => ({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal mock shape for test
        accounts: [
          { id: 'acc-1', credentials: '{"token":"creds-1"}' },
          { id: 'acc-2', credentials: '{"token":"creds-2"}' }
        ] as never,
        selectedAccountId: 'acc-1'
      }),
      write: vi.fn(),
      updateAccountUsage: vi.fn()
    })

    const env1: NodeJS.ProcessEnv = { HOME: '/task/home' }
    const env2: NodeJS.ProcessEnv = { HOME: '/task/home' }

    await Promise.all([
      prepareAntigravityAccountForLaunch({
        launchAgent: 'antigravity',
        launchAccountId: 'acc-1',
        env: env1
      }),
      prepareAntigravityAccountForLaunch({
        launchAgent: 'antigravity',
        launchAccountId: 'acc-2',
        env: env2
      })
    ])

    expect(ensureAntigravityAccountProfile).toHaveBeenCalledWith('acc-1', '{"token":"creds-1"}')
    expect(ensureAntigravityAccountProfile).toHaveBeenCalledWith('acc-2', '{"token":"creds-2"}')
    expect(selectAccount).not.toHaveBeenCalled()
    expect(writeAntigravityWindowsCredential).not.toHaveBeenCalled()

    expect(env1.HOME).toBe('/task/profiles/acc-1')
    expect(env1.USERPROFILE).toBe('/task/profiles/acc-1')
    expect(env1.ANTIGRAVITY_PROFILE_DIR).toBe('/task/profiles/acc-1/.gemini/antigravity-cli')
    expect(env1.SSH_CLIENT).toBe('127.0.0.1 0 0')

    expect(env2.HOME).toBe('/task/profiles/acc-2')
    expect(env2.USERPROFILE).toBe('/task/profiles/acc-2')
    expect(env2.ANTIGRAVITY_PROFILE_DIR).toBe('/task/profiles/acc-2/.gemini/antigravity-cli')
    expect(env2.SSH_CLIENT).toBe('127.0.0.1 0 0')
  })

  it('injects profile environment into args.env when launchAccountId is present in the vault', async () => {
    vi.mocked(createEncryptedAntigravityAccountStore).mockReturnValue({
      read: () => ({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal mock shape for test
        accounts: [
          { id: 'acc-1', credentials: '{"token":"creds-1"}' },
          { id: 'acc-2', credentials: '{"token":"creds-2"}' }
        ] as never,
        selectedAccountId: 'acc-1'
      }),
      write: vi.fn(),
      updateAccountUsage: vi.fn()
    })
    const env: NodeJS.ProcessEnv = { HOME: '/task/home' }
    await prepareAntigravityAccountForLaunch({
      launchAgent: 'antigravity',
      launchAccountId: 'acc-2',
      env
    })
    expect(ensureAntigravityAccountProfile).toHaveBeenCalledWith('acc-2', '{"token":"creds-2"}')
    expect(selectAccount).not.toHaveBeenCalled()
    expect(prepareForLaunch).not.toHaveBeenCalled()
    expect(env.HOME).toBe('/task/profiles/acc-2')
    expect(env.USERPROFILE).toBe('/task/profiles/acc-2')
    expect(env.ANTIGRAVITY_PROFILE_DIR).toBe('/task/profiles/acc-2/.gemini/antigravity-cli')
    expect(env.SSH_CLIENT).toBe('127.0.0.1 0 0')
  })

  it('falls back to prepareForLaunch when launchAccountId is unknown or deleted from vault (Review Focus #2)', async () => {
    vi.mocked(createEncryptedAntigravityAccountStore).mockReturnValue({
      read: () => ({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal mock shape for test
        accounts: [{ id: 'acc-1', credentials: '{"token":"creds-1"}' }] as never,
        selectedAccountId: 'acc-1'
      }),
      write: vi.fn(),
      updateAccountUsage: vi.fn()
    })
    const env: NodeJS.ProcessEnv = { HOME: '/task/home' }
    await prepareAntigravityAccountForLaunch({
      launchAgent: 'antigravity',
      launchAccountId: 'deleted-acc',
      env
    })
    expect(prepareForLaunch).toHaveBeenCalledOnce()
    expect(selectAccount).not.toHaveBeenCalled()
    expect(ensureAntigravityAccountProfile).not.toHaveBeenCalled()
    expect(env.HOME).toBe('/task/home')
  })

  it('degrades safely without error when launchAccountId is missing and vault has no selectedAccountId (Review Focus #2)', async () => {
    vi.mocked(createEncryptedAntigravityAccountStore).mockReturnValue({
      read: () => ({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal mock shape for test
        accounts: [{ id: 'acc-1', credentials: '{"token":"creds-1"}' }] as never,
        selectedAccountId: null
      }),
      write: vi.fn(),
      updateAccountUsage: vi.fn()
    })
    const env: NodeJS.ProcessEnv = { HOME: '/task/home' }
    await expect(
      prepareAntigravityAccountForLaunch({
        launchAgent: 'antigravity',
        launchAccountId: 'deleted-acc',
        env
      })
    ).resolves.toBeUndefined()
    expect(prepareForLaunch).not.toHaveBeenCalled()
    expect(selectAccount).not.toHaveBeenCalled()
    expect(ensureAntigravityAccountProfile).not.toHaveBeenCalled()
    expect(env.HOME).toBe('/task/home')
  })
})
