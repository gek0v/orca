import { z } from 'zod'
import { net } from 'electron'
import type { RateLimitBucket } from '../../shared/rate-limit-types'
import { getBucketName } from './gemini-bucket-formatting'
import { deriveMostConstrainedWindow } from './rate-limit-bucket-summary'
import type { AntigravityUsageBucket, AntigravityUsageReading } from './antigravity-usage-response'

const LOAD_CODE_ASSIST_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'
const RETRIEVE_QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota'
const API_TIMEOUT_MS = 10_000

const cloudCodeQuotaBucketSchema = z.looseObject({
  remainingFraction: z.number(),
  resetTime: z.string(),
  modelId: z.string()
})

export type CloudCodeQuotaBucket = z.infer<typeof cloudCodeQuotaBucketSchema>

const quotaResponseSchema = z.union([
  z.array(cloudCodeQuotaBucketSchema),
  z.looseObject({
    buckets: z.array(cloudCodeQuotaBucketSchema).optional()
  })
])

const projectResponseSchema = z.looseObject({
  cloudaicompanionProject: z.string().optional()
})

export type FetchAntigravityCloudCodeQuotaOptions = {
  signal?: AbortSignal
  fetchFn?: typeof net.fetch
  now?: () => number
}

function parseQuotaBuckets(data: unknown): CloudCodeQuotaBucket[] {
  const parsed = quotaResponseSchema.safeParse(data)
  if (!parsed.success) {
    return []
  }
  if (Array.isArray(parsed.data)) {
    return parsed.data
  }
  return parsed.data.buckets ?? []
}

export async function fetchAntigravityCloudCodeQuota(
  accessToken: string,
  options: FetchAntigravityCloudCodeQuotaOptions = {}
): Promise<AntigravityUsageReading | null> {
  const fetcher = options.fetchFn ?? net.fetch
  const nowMs = options.now?.() ?? Date.now()

  let projectId: string | null = null
  try {
    const projectRes = await fetcher(LOAD_CODE_ASSIST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY', pluginType: 'GEMINI' } }),
      signal: options.signal ?? AbortSignal.timeout(API_TIMEOUT_MS)
    })
    if (projectRes.ok) {
      const data: unknown = await projectRes.json().catch(() => null)
      const parsed = projectResponseSchema.safeParse(data)
      if (parsed.success && parsed.data.cloudaicompanionProject) {
        projectId = parsed.data.cloudaicompanionProject
      }
    }
  } catch {
    // Fall back to empty project payload on metadata load failure.
  }

  const quotaRes = await fetcher(RETRIEVE_QUOTA_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify(projectId ? { project: projectId } : {}),
    signal: options.signal ?? AbortSignal.timeout(API_TIMEOUT_MS)
  })

  if (!quotaRes.ok) {
    return null
  }

  const data: unknown = await quotaRes.json().catch(() => null)
  const parsed = parseQuotaBuckets(data)
  if (parsed.length === 0) {
    return null
  }

  const buckets: AntigravityUsageBucket[] = []
  for (const b of parsed) {
    const resetsAt = new Date(b.resetTime).getTime()
    const isWeekly = Number.isFinite(resetsAt) && resetsAt - nowMs > 24 * 3600 * 1000
    const windowMinutes = isWeekly ? 10_080 : 300
    const usedPercent = Math.min(100, Math.max(0, Math.round((1 - b.remainingFraction) * 100)))
    buckets.push({
      id: b.modelId,
      name: getBucketName(b.modelId),
      usedPercent,
      windowMinutes,
      resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
      resetDescription: null
    })
  }

  const windowsOf = (minutes: number): RateLimitBucket[] =>
    buckets
      .filter((bucket) => bucket.windowMinutes === minutes)
      .map(({ id: _id, ...bucket }) => bucket)

  return {
    session: deriveMostConstrainedWindow(windowsOf(300)),
    weekly: deriveMostConstrainedWindow(windowsOf(10_080)),
    buckets,
    description: 'Direct zero-cost quota via Google CloudCode API.'
  }
}
