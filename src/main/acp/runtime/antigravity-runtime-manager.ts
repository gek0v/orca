import { existsSync, chmodSync, mkdirSync, rmSync, createWriteStream } from 'node:fs'
import { join, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { runProcess } from '../../../shared/child-process/run-process'
import { getZipExtractorCommand } from '../../../shared/zip-extractor-command'
import { ANTIGRAVITY_PLATFORM_CATALOG } from './antigravity-runtime-catalog'
export { ANTIGRAVITY_PLATFORM_CATALOG } from './antigravity-runtime-catalog'

export function resolveAntigravityPlatformKey(
  platform: string = process.platform,
  arch: string = process.arch
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
  env?: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>
  homePath?: string
  platform?: NodeJS.Platform
}

const binaryResolutionCache = new Map<string, AntigravityBinaryResolution | null>()

export function clearAntigravityAcpBinaryCacheForTests(): void {
  binaryResolutionCache.clear()
}

function doResolveAntigravityAcpBinary(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform
): AntigravityBinaryResolution | null {
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

  // 4. Windows AppData bin: %LOCALAPPDATA%/agy/bin/<binary>
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    const appDataBin = join(localAppData, 'agy', 'bin', binName)
    if (existsSync(appDataBin)) {
      return { command: appDataBin, source: 'user-bin' }
    }
  }

  // 5. Account home current / bin: ~/.gemini/antigravity-acp/current/<binary>
  const geminiAcpCurrent = join(home, '.gemini', 'antigravity-acp', 'current', binName)
  if (existsSync(geminiAcpCurrent)) {
    return { command: geminiAcpCurrent, source: 'managed' }
  }
  const geminiAcpBin = join(home, '.gemini', 'antigravity-acp', 'bin', binName)
  if (existsSync(geminiAcpBin)) {
    return { command: geminiAcpBin, source: 'managed' }
  }

  // 6. PATH search
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

export function resolveAntigravityAcpBinary(
  input: ResolveAntigravityBinaryInput = {}
): AntigravityBinaryResolution | null {
  const env = input.env ?? process.env
  const home = input.homePath ?? homedir()
  const platform = input.platform ?? process.platform
  const explicitEnv = env.AGY_ACP_BIN?.trim() ?? ''
  const localAppData = env.LOCALAPPDATA ?? ''
  const pathEnv = env.PATH ?? env.Path ?? ''
  const cacheKey = `${platform}:${process.arch}:${home}:${explicitEnv}:${localAppData}:${pathEnv}`

  if (binaryResolutionCache.has(cacheKey)) {
    return binaryResolutionCache.get(cacheKey) ?? null
  }

  const result = doResolveAntigravityAcpBinary(env, home, platform)
  binaryResolutionCache.set(cacheKey, result)
  return result
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

export type InstallAntigravityAcpRuntimeOptions = {
  homePath?: string
  platform?: NodeJS.Platform
  arch?: string
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  runProcessImpl?: typeof runProcess
}

export async function installAntigravityAcpRuntime(
  options: InstallAntigravityAcpRuntimeOptions = {}
): Promise<string> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const key = resolveAntigravityPlatformKey(platform, arch)
  if (!key || !ANTIGRAVITY_PLATFORM_CATALOG[key]) {
    throw new Error(`Unsupported Antigravity platform: ${platform}-${arch}`)
  }
  const artifact = ANTIGRAVITY_PLATFORM_CATALOG[key]
  const home = options.homePath ?? homedir()
  const installDir = getAntigravityManagedInstallDir(home)
  const binName = resolveAntigravityBinaryName(platform)
  const binPath = join(installDir, binName)

  const tempDir = join(installDir, '..', 'tmp')
  mkdirSync(tempDir, { recursive: true })
  const tempZipPath = join(tempDir, `agy-acp-${Date.now()}.zip`)

  const fetcher = options.fetchImpl ?? fetch
  const response = await fetcher(artifact.archive, { signal: options.signal })
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download Antigravity ACP runtime: HTTP ${response.status}`)
  }

  const hasher = createHash('sha256')
  const hashStream = new Transform({
    transform(chunk, _encoding, callback) {
      hasher.update(chunk)
      callback(null, chunk)
    }
  })

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: response.body is a web ReadableStream
  const bodyStream = response.body as Parameters<typeof Readable.fromWeb>[0]
  await pipeline(Readable.fromWeb(bodyStream), hashStream, createWriteStream(tempZipPath))

  const digest = hasher.digest('hex')
  if (digest !== artifact.archiveSha256) {
    try {
      rmSync(tempZipPath, { force: true })
    } catch {
      // Best-effort cleanup
    }
    throw new Error(
      `Checksum mismatch for Antigravity archive: expected ${artifact.archiveSha256}, got ${digest}`
    )
  }

  mkdirSync(installDir, { recursive: true })
  const extractCmd = getZipExtractorCommand(tempZipPath, installDir)
  const runner = options.runProcessImpl ?? runProcess
  const result = await runner({
    program: extractCmd.file,
    args: extractCmd.args,
    timeoutMs: 120_000,
    signal: options.signal
  })

  try {
    rmSync(tempZipPath, { force: true })
  } catch {
    // Best-effort cleanup
  }

  if (result.code !== 0) {
    throw new Error(`Failed to extract Antigravity archive: ${result.stderr}`)
  }

  ensureAntigravityHelperPermissions(installDir, platform)
  if (!existsSync(binPath)) {
    throw new Error(`Antigravity binary missing after extraction: ${binPath}`)
  }
  binaryResolutionCache.clear()
  return binPath
}

export async function ensureAntigravityAcpRuntime(
  options: InstallAntigravityAcpRuntimeOptions = {}
): Promise<string> {
  const existing = resolveAntigravityAcpBinary(options)
  if (existing) {
    return existing.command
  }
  return await installAntigravityAcpRuntime(options)
}
