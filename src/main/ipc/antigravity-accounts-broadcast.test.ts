import { beforeEach, describe, expect, it, vi } from 'vitest'

const getAllWindows = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows } }))

import {
  broadcastAntigravityAccountsChanged,
  ANTIGRAVITY_ACCOUNTS_CHANGED_CHANNEL
} from './antigravity-accounts-broadcast'
import type { AntigravityAccountState } from '../../shared/antigravity-account-types'

describe('antigravity accounts broadcast', () => {
  beforeEach(() => getAllWindows.mockReset())

  it('publishes to live renderer windows and skips destroyed windows', () => {
    const live = { isDestroyed: () => false, webContents: { send: vi.fn() } }
    const destroyed = { isDestroyed: () => true, webContents: { send: vi.fn() } }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Synthetic window mocks
    getAllWindows.mockReturnValue([live, destroyed])

    const state: AntigravityAccountState = {
      accounts: [],
      activeAccountId: 'acc-1',
      currentAccount: null,
      selectedAccountId: null
    }

    broadcastAntigravityAccountsChanged(state)

    expect(live.webContents.send).toHaveBeenCalledWith(ANTIGRAVITY_ACCOUNTS_CHANGED_CHANNEL, state)
    expect(destroyed.webContents.send).not.toHaveBeenCalled()
  })
})
