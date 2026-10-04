import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadWindowsNativeCredentials } from '../windows-native-credentials'
import { encodeAntigravityKeychainValue } from './native-credential-codec'
import {
  readAntigravityWindowsCredential,
  writeAntigravityWindowsCredential
} from './native-windows-credentials'

vi.mock('../windows-native-credentials', () => ({ loadWindowsNativeCredentials: vi.fn() }))

const contents = JSON.stringify({ auth_method: 'consumer', token: { access_token: 'synthetic' } })
const stored = Buffer.from(encodeAntigravityKeychainValue(contents), 'utf8')

function mockAddon(store: Map<string, Buffer>) {
  vi.mocked(loadWindowsNativeCredentials).mockReturnValue({
    readCredential: (target: string) => store.get(target) ?? null,
    writeCredential: (target: string, blob: Buffer | Uint8Array) => {
      store.set(target, Buffer.from(blob))
      return true
    },
    deleteCredential: (target: string) => store.delete(target)
  })
}

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.mocked(loadWindowsNativeCredentials).mockClear()
})

afterEach(() => vi.restoreAllMocks())

describe('Antigravity Windows credential access', () => {
  it('reads the native agy item through the exact live target', async () => {
    mockAddon(new Map([['gemini:antigravity', stored]]))
    expect((await readAntigravityWindowsCredential())?.contents).toBe(contents)
    expect(loadWindowsNativeCredentials).toHaveBeenCalled()
  })

  it('reports a missing item as null instead of throwing', async () => {
    mockAddon(new Map())
    expect(await readAntigravityWindowsCredential()).toBeNull()
  })

  it('writes credentials and verifies the complete native blob', async () => {
    const store = new Map<string, Buffer>()
    mockAddon(store)
    await writeAntigravityWindowsCredential(contents)
    expect(store.get('gemini:antigravity')?.toString('utf8')).toBe(contents)
  })

  it('validates before touching the active login', async () => {
    const store = new Map<string, Buffer>([['gemini:antigravity', stored]])
    mockAddon(store)
    await expect(writeAntigravityWindowsCredential('not-json')).rejects.toThrow()
    expect(store.get('gemini:antigravity')).toBe(stored)
  })

  it('does not claim a successful switch when readback differs', async () => {
    mockAddon(new Map())
    vi.mocked(loadWindowsNativeCredentials).mockReturnValue({
      readCredential: () =>
        Buffer.from('{"auth_method":"consumer","token":{"access_token":"another"}}'),
      writeCredential: () => true,
      deleteCredential: () => false
    })
    await expect(writeAntigravityWindowsCredential(contents)).rejects.toThrow(
      'could not be verified'
    )
  })

  it('rejects oversized writes before touching the active login', async () => {
    const store = new Map<string, Buffer>([['gemini:antigravity', stored]])
    mockAddon(store)
    const large = contents.replace('synthetic', 'x'.repeat(70_000))
    await expect(writeAntigravityWindowsCredential(large)).rejects.toThrow()
    expect(store.get('gemini:antigravity')).toBe(stored)
  })

  it.each(['darwin', 'linux'] as const)(
    'does not answer for a different host (%s)',
    async (platform) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
      await expect(readAntigravityWindowsCredential()).rejects.toThrow('unavailable on this host')
      await expect(writeAntigravityWindowsCredential(contents)).rejects.toThrow(
        'unavailable on this host'
      )
      expect(loadWindowsNativeCredentials).not.toHaveBeenCalled()
    }
  )
})
