import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  refreshAntigravityAccounts,
  setCachedAntigravityAccountsState
} from './useAntigravityAccounts'
import { callAntigravityAccounts } from '@/runtime/runtime-antigravity-accounts-client'
import type { AntigravityAccountState } from '../../../shared/antigravity-account-types'

vi.mock('@/runtime/runtime-antigravity-accounts-client', () => ({
  callAntigravityAccounts: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: vi.fn()
}))

describe('refreshAntigravityAccounts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setCachedAntigravityAccountsState(null)
  })

  it('deduplicates concurrent in-flight requests', async () => {
    const mockState: AntigravityAccountState = {
      activeAccountId: 'acc-1',
      accounts: [
        {
          id: 'acc-1',
          email: 'test@example.com',
          subject: 'sub-1',
          authMethod: 'oauth',
          alias: 'Work',
          emoji: '💼',
          color: null,
          createdAt: 0,
          updatedAt: 0,
          lastUsage: null,
          lastUsageAt: null
        }
      ],
      currentAccount: null,
      selectedAccountId: null
    }

    let resolveCall: (res: AntigravityAccountState) => void = () => {}
    const deferredPromise = new Promise<AntigravityAccountState>((resolve) => {
      resolveCall = resolve
    })

    vi.mocked(callAntigravityAccounts).mockReturnValue(deferredPromise)

    const call1 = refreshAntigravityAccounts()
    const call2 = refreshAntigravityAccounts()

    expect(callAntigravityAccounts).toHaveBeenCalledTimes(1)
    expect(call1).toBe(call2)

    resolveCall(mockState)

    const [res1, res2] = await Promise.all([call1, call2])
    expect(res1).toEqual(mockState)
    expect(res2).toEqual(mockState)

    // After completion, next call makes a new request
    vi.mocked(callAntigravityAccounts).mockResolvedValueOnce(mockState)
    await refreshAntigravityAccounts()
    expect(callAntigravityAccounts).toHaveBeenCalledTimes(2)
  })
})
