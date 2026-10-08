import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import type { AntigravityNativeCredential } from '../antigravity/native-credential-codec'
import { fetchAntigravityCloudCodeQuota } from './antigravity-cloudcode-quota'
import type { AntigravityUsageReading } from './antigravity-usage-response'

export const DEFAULT_CREDENTIAL_TIMEOUT_MS = 2_000
export const DEFAULT_DIRECT_QUOTA_TIMEOUT_MS = 5_000

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallbackValue: T,
  signal?: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | null = null

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (signal) {
        signal.removeEventListener('abort', onAbort)
      }
    }

    const onAbort = (): void => {
      if (!settled) {
        settled = true
        cleanup()
        resolve(fallbackValue)
      }
    }

    if (signal?.aborted) {
      resolve(fallbackValue)
      return
    }

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    timer = setTimeout(() => {
      if (!settled) {
        settled = true
        cleanup()
        resolve(fallbackValue)
      }
    }, ms)
    timer.unref?.()

    promise
      .then((val) => {
        if (!settled) {
          settled = true
          cleanup()
          resolve(val)
        }
      })
      .catch(() => {
        if (!settled) {
          settled = true
          cleanup()
          resolve(fallbackValue)
        }
      })
  })
}

export type FetchAntigravityDirectQuotaOptions = {
  platform?: NodeJS.Platform
  readNativeCredential?: () => Promise<AntigravityNativeCredential | null>
  fetchDirectQuota?: (
    accessToken: string,
    options?: { signal?: AbortSignal; now?: () => number }
  ) => Promise<AntigravityUsageReading | null>
  signal?: AbortSignal
  now?: () => number
  credentialTimeoutMs?: number
  directQuotaTimeoutMs?: number
}

export async function fetchAntigravityDirectQuota(
  options: FetchAntigravityDirectQuotaOptions = {}
): Promise<ProviderRateLimits | null> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32' && !options.readNativeCredential) {
    return null
  }
  const now = options.now ?? Date.now

  try {
    const credTimeoutMs = options.credentialTimeoutMs ?? DEFAULT_CREDENTIAL_TIMEOUT_MS
    const readCred =
      options.readNativeCredential ??
      (async () => {
        const { readAntigravityWindowsCredential } =
          await import('../antigravity/native-windows-credentials')
        return readAntigravityWindowsCredential()
      })
    const cred = await withTimeout(
      Promise.resolve().then(() => readCred()),
      credTimeoutMs,
      null,
      options.signal
    )
    if (cred?.accessToken) {
      const directTimeoutMs = options.directQuotaTimeoutMs ?? DEFAULT_DIRECT_QUOTA_TIMEOUT_MS
      const fetchDirect = options.fetchDirectQuota ?? fetchAntigravityCloudCodeQuota
      const reading = await withTimeout(
        Promise.resolve().then(() =>
          fetchDirect(cred.accessToken, {
            signal: options.signal,
            now
          })
        ),
        directTimeoutMs,
        null,
        options.signal
      )
      if (reading) {
        return {
          provider: 'antigravity',
          session: reading.session,
          weekly: reading.weekly,
          buckets: reading.buckets.map(({ id: _id, ...bucket }) => bucket),
          updatedAt: now(),
          error: null,
          status: 'ok',
          usageMetadata: {
            source: 'oauth',
            attemptedSources: ['oauth'],
            lastSuccessfulSource: 'oauth',
            credentialSource: 'antigravity-keychain'
          }
        }
      }
    }
  } catch {
    // Direct token quota read failed; return null to proceed.
  }

  return null
}
