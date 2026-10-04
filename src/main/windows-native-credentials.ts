import { createRequire } from 'node:module'

export type WindowsNativeCredentialsModule = {
  readCredential: (target: string) => Buffer | null | undefined
  writeCredential: (target: string, blob: Buffer | Uint8Array) => boolean | undefined
  deleteCredential: (target: string) => boolean | undefined
}

const requireFromMain = createRequire(__filename)

export function loadWindowsNativeCredentials(): WindowsNativeCredentialsModule {
  // Why: non-Windows installs omit this optional dependency, so never resolve it at module load.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Native C++ addon loaded dynamically when running on Windows host.
  return requireFromMain('@orca/windows-credentials') as WindowsNativeCredentialsModule
}
