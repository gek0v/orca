import { createRequire } from 'node:module'

export type WindowsNativeCredentialsModule = {
  readCredential: (target: string) => Buffer | null | undefined
  writeCredential: (target: string, blob: Buffer | Uint8Array) => boolean | undefined
  deleteCredential: (target: string) => boolean | undefined
}

const requireFromMain = createRequire(__filename)

export function loadWindowsNativeCredentials(): WindowsNativeCredentialsModule {
  // Why: non-Windows installs omit this optional dependency, so never resolve it at module load.
  return requireFromMain('@orca/windows-credentials') as WindowsNativeCredentialsModule
}
