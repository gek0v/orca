import { existsSync, chmodSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import { homedir } from 'node:os'
export { ANTIGRAVITY_PLATFORM_CATALOG } from './antigravity-runtime-catalog'

export function resolveAntigravityPlatformKey(
  platform = process.platform,
  arch = process.arch
): string | null {
  if (platform === 'win32') {
    if (arch === 'x64') {
      return 'windows-x86_64'
    }
    if (arch === 'arm64') {
      return 'windows-aarch64'
    }
    return null
  }
  if (platform === 'linux') {
    if (arch === 'x64') {
      return 'linux-x86_64'
    }
    if (arch === 'arm64') {
      return 'linux-aarch64'
    }
    return null
  }
  if (platform === 'darwin') {
    if (arch === 'arm64') {
      return 'darwin-aarch64'
    }
    return null
  }
  return null
}

export function resolveAntigravityBinaryName(platform = process.platform): string {
  return platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par'
}

export function getAntigravityManagedInstallDir(homePath = homedir()): string {
  return join(homePath, '.local', 'opt', 'agy-acp', 'current')
}

export type AntigravityBinaryResolution = {
  command: string
  source: 'env' | 'managed' | 'user-bin' | 'path'
}

export type ResolveAntigravityBinaryInput = {
  env?: NodeJS.ProcessEnv
  homePath?: string
  platform?: NodeJS.Platform
}

export function resolveAntigravityAcpBinary(
  input: ResolveAntigravityBinaryInput = {}
): AntigravityBinaryResolution | null {
  const env = input.env ?? process.env
  const home = input.homePath ?? homedir()
  const platform = input.platform ?? process.platform
  const binName = resolveAntigravityBinaryName(platform)

  // 1. Explicit AGY_ACP_BIN
  const explicitEnv = env.AGY_ACP_BIN?.trim()
  if (explicitEnv && existsSync(explicitEnv)) {
    return { command: explicitEnv, source: 'env' }
  }

  // 2. Managed release: ~/.local/opt/agy-acp/current/<binary>
  const managedPath = join(getAntigravityManagedInstallDir(home), binName)
  if (existsSync(managedPath)) {
    return { command: managedPath, source: 'managed' }
  }

  // 3. User bin: ~/.local/bin/<binary>
  const userBinPath = join(home, '.local', 'bin', binName)
  if (existsSync(userBinPath)) {
    return { command: userBinPath, source: 'user-bin' }
  }

  // 4. PATH search
  const pathEnv = env.PATH ?? env.Path ?? ''
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) {
      continue
    }
    const candidate = join(dir, binName)
    if (existsSync(candidate)) {
      return { command: candidate, source: 'path' }
    }
  }

  return null
}

export function ensureAntigravityHelperPermissions(
  installDir: string,
  platform = process.platform
): void {
  if (platform === 'win32') {
    return
  }
  const binary = join(installDir, 'agy_acp_server.par')
  const helper = join(installDir, 'localharness_external')
  for (const file of [binary, helper]) {
    if (existsSync(file)) {
      try {
        chmodSync(file, 0o755)
      } catch {
        // Best-effort permission fix
      }
    }
  }
}
