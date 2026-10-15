import { describe, expect, it } from 'vitest'
import { shouldAdoptNativeOrcadProvider } from './daemon-provider-init'

describe('shouldAdoptNativeOrcadProvider', () => {
  it('adopts native binary when present and not explicitly disabled', () => {
    expect(shouldAdoptNativeOrcadProvider({ hasNativeBinary: true, env: {} })).toBe(true)
    expect(
      shouldAdoptNativeOrcadProvider({
        hasNativeBinary: true,
        env: { ORCA_DISABLE_NATIVE_ORCAD: '1' }
      })
    ).toBe(false)
    expect(shouldAdoptNativeOrcadProvider({ hasNativeBinary: false, env: {} })).toBe(false)
  })

  it('respects force enable via ORCA_USE_NATIVE_ORCAD', () => {
    expect(
      shouldAdoptNativeOrcadProvider({
        hasNativeBinary: false,
        env: { ORCA_USE_NATIVE_ORCAD: '1' }
      })
    ).toBe(true)
  })

  it('prioritizes explicit disable over force enable', () => {
    expect(
      shouldAdoptNativeOrcadProvider({
        hasNativeBinary: true,
        env: { ORCA_DISABLE_NATIVE_ORCAD: '1', ORCA_USE_NATIVE_ORCAD: '1' }
      })
    ).toBe(false)
  })
})
