import { loadWindowsNativeCredentials } from '../windows-native-credentials'
import {
  decodeAntigravityKeychainValue,
  parseAntigravityNativeCredential,
  type AntigravityNativeCredential
} from './native-credential-codec'

// Exact Credential Manager target agy uses on Windows (verified against a live
// keyring); the service/account split of other platforms does not apply here.
const WINDOWS_CREDENTIAL_TARGET = 'gemini:antigravity'

function requireWindows(): void {
  if (process.platform !== 'win32') {
    throw new Error('The Antigravity Windows credential store is unavailable on this host.')
  }
}

export async function readAntigravityWindowsCredential(): Promise<AntigravityNativeCredential | null> {
  requireWindows()
  const blob = loadWindowsNativeCredentials().readCredential(WINDOWS_CREDENTIAL_TARGET)
  if (!blob) {
    return null
  }
  return parseAntigravityNativeCredential(decodeAntigravityKeychainValue(blob.toString('utf8')))
}

export async function writeAntigravityWindowsCredential(contents: string): Promise<void> {
  requireWindows()
  parseAntigravityNativeCredential(contents)
  const updated = loadWindowsNativeCredentials().writeCredential(
    WINDOWS_CREDENTIAL_TARGET,
    Buffer.from(contents, 'utf8')
  )
  if (!updated) {
    throw new Error('The Antigravity Windows credential store could not be updated.')
  }
  const actual = await readAntigravityWindowsCredential()
  if (actual?.contents !== contents) {
    throw new Error('The Antigravity Windows credential update could not be verified.')
  }
}
