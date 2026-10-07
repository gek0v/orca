import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { loadWindowsNativeCredentials } from './windows-native-credentials'

// Why this file exists: the addon behind `@orca/windows-credentials` is vendored source rather
// than a published package, so nothing upstream proves it round-trips Credential Manager the way
// the Antigravity account service expects. These cases run against a synthetic target only and
// never touch the real agy login.
const describeWindows = process.platform === 'win32' ? describe : describe.skip

function syntheticTarget(): string {
  return `OrcaAntigravityAdapterSelfTest/${randomUUID()}`
}

describeWindows('vendored windows credentials addon', () => {
  it('round-trips arbitrary bytes byte-for-byte, then deletes the item', () => {
    const credentials = loadWindowsNativeCredentials()
    const target = syntheticTarget()
    const blob = Buffer.from(
      JSON.stringify({ auth_method: 'consumer', token: { access_token: 'síntesis-✓' } }),
      'utf8'
    )

    expect(credentials.readCredential(target)).toBeNull()
    expect(credentials.writeCredential(target, blob)).toBe(true)
    expect(credentials.readCredential(target)?.equals(blob)).toBe(true)
    expect(credentials.deleteCredential(target)).toBe(true)
    expect(credentials.readCredential(target)).toBeNull()
    expect(credentials.deleteCredential(target)).toBe(false)
  })

  it('rejects oversized blobs before touching the store', () => {
    const credentials = loadWindowsNativeCredentials()
    const oversized = Buffer.alloc(64 * 1024 + 1, 0x41)
    expect(() => credentials.writeCredential(syntheticTarget(), oversized)).toThrow()
  })

  it('rejects an empty target instead of addressing the wrong credential', () => {
    const credentials = loadWindowsNativeCredentials()
    expect(() => credentials.readCredential('')).toThrow()
    expect(() => credentials.deleteCredential('')).toThrow()
  })
})
