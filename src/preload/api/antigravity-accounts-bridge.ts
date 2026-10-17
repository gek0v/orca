import { ipcRenderer } from 'electron'
import {
  ANTIGRAVITY_ACCOUNTS_CHANGED_CHANNEL,
  type AntigravityAccountState
} from '../../shared/antigravity-account-types'

export type AntigravityAccountsApi = {
  onAccountsChanged: (callback: (state: AntigravityAccountState) => void) => () => void
}

export const antigravityAccountsApi: AntigravityAccountsApi = {
  onAccountsChanged: (callback: (state: AntigravityAccountState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AntigravityAccountState) =>
      callback(state)
    ipcRenderer.on(ANTIGRAVITY_ACCOUNTS_CHANGED_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(ANTIGRAVITY_ACCOUNTS_CHANGED_CHANNEL, listener)
    }
  }
}
