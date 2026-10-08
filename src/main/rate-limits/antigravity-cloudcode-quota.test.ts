import type { net } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { fetchAntigravityCloudCodeQuota } from './antigravity-cloudcode-quota'

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('fetchAntigravityCloudCodeQuota', () => {
  const baseTime = new Date('2026-04-24T12:00:00.000Z').getTime()

  it('fetches project and quota successfully, returning formatted reading', async () => {
    const fetchMock = vi.fn<typeof net.fetch>().mockImplementation(async (url) => {
      const urlStr = String(url)
      if (urlStr.includes('loadCodeAssist')) {
        return makeResponse({ cloudaicompanionProject: 'test-project-123' })
      }
      if (urlStr.includes('retrieveUserQuota')) {
        return makeResponse({
          buckets: [
            {
              remainingFraction: 0.8,
              resetTime: '2026-04-24T15:00:00.000Z',
              modelId: 'gemini-3.1-pro'
            },
            {
              remainingFraction: 0.4,
              resetTime: '2026-05-01T12:00:00.000Z',
              modelId: 'gemini-3.1-flash'
            }
          ]
        })
      }
      return makeResponse({}, 404)
    })

    const reading = await fetchAntigravityCloudCodeQuota('test-access-token', {
      fetchFn: fetchMock,
      now: () => baseTime
    })

    expect(reading).not.toBeNull()
    expect(reading?.buckets).toHaveLength(2)

    // First bucket is within 3 hours -> session window (300m), 20% used
    const proBucket = reading?.buckets.find((b) => b.id === 'gemini-3.1-pro')
    expect(proBucket).toMatchObject({
      name: '3.1 Pro',
      usedPercent: 20,
      windowMinutes: 300
    })

    // Second bucket is 7 days away -> weekly window (10080m), 60% used
    const flashBucket = reading?.buckets.find((b) => b.id === 'gemini-3.1-flash')
    expect(flashBucket).toMatchObject({
      name: '3.1 Flash',
      usedPercent: 60,
      windowMinutes: 10_080
    })

    expect(reading?.weekly).toMatchObject({
      usedPercent: 60,
      windowMinutes: 10_080
    })
    expect(reading?.session).toMatchObject({
      usedPercent: 20,
      windowMinutes: 300
    })
  })

  it('falls back to empty project payload if loadCodeAssist fails', async () => {
    const fetchMock = vi.fn<typeof net.fetch>().mockImplementation(async (url) => {
      const urlStr = String(url)
      if (urlStr.includes('loadCodeAssist')) {
        return makeResponse({}, 500)
      }
      if (urlStr.includes('retrieveUserQuota')) {
        return makeResponse([
          {
            remainingFraction: 0.9,
            resetTime: '2026-04-24T14:00:00.000Z',
            modelId: 'gemini-2.5-pro'
          }
        ])
      }
      return makeResponse({}, 404)
    })

    const reading = await fetchAntigravityCloudCodeQuota('test-access-token', {
      fetchFn: fetchMock,
      now: () => baseTime
    })

    expect(reading).not.toBeNull()
    expect(reading?.buckets).toHaveLength(1)
    expect(reading?.buckets[0]?.name).toBe('Pro')
    expect(reading?.buckets[0]?.usedPercent).toBe(10)
  })

  it('returns null if retrieveUserQuota returns non-ok response', async () => {
    const fetchMock = vi.fn<typeof net.fetch>().mockImplementation(async (url) => {
      const urlStr = String(url)
      if (urlStr.includes('loadCodeAssist')) {
        return makeResponse({ cloudaicompanionProject: 'test-project-123' })
      }
      if (urlStr.includes('retrieveUserQuota')) {
        return makeResponse({ error: 'unauthorized' }, 401)
      }
      return makeResponse({}, 404)
    })

    const reading = await fetchAntigravityCloudCodeQuota('test-access-token', {
      fetchFn: fetchMock,
      now: () => baseTime
    })

    expect(reading).toBeNull()
  })

  it('returns null if retrieveUserQuota returns empty or invalid buckets', async () => {
    const fetchMock = vi.fn<typeof net.fetch>().mockImplementation(async (url) => {
      const urlStr = String(url)
      if (urlStr.includes('retrieveUserQuota')) {
        return makeResponse({ buckets: [] })
      }
      return makeResponse({})
    })

    const reading = await fetchAntigravityCloudCodeQuota('test-access-token', {
      fetchFn: fetchMock,
      now: () => baseTime
    })

    expect(reading).toBeNull()
  })
})
