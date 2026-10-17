import { BrowserWindow } from 'electron'
import {
  ANTIGRAVITY_ACCOUNTS_CHANGED_CHANNEL,
  type AntigravityAccountState
} from '../../shared/antigravity-account-types'

export { ANTIGRAVITY_ACCOUNTS_CHANGED_CHANNEL }

export function broadcastAntigravityAccountsChanged(state: AntigravityAccountState): void {
  try {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) {
        continue
      }
      try {
        window.webContents.send(ANTIGRAVITY_ACCOUNTS_CHANGED_CHANNEL, state)
      } catch {
        // A renderer can disappear between isDestroyed() and send().
      }
    }
  } catch {
    // Non-electron test runner fallback
  }
}
