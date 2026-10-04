import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, string>) => {
    let result = fallback
    for (const [key, value] of Object.entries(values ?? {})) {
      result = result.replace(`{{${key}}}`, value)
    }
    return result
  }
}))

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => null
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { usagePercentageDisplay: 'used' | 'remaining' }) => unknown) =>
    selector({ usagePercentageDisplay: 'used' })
}))

const WEEKLY_MINUTES = 10_080

function weeklyWindow(usedPercent: number): RateLimitWindow {
  return { usedPercent, windowMinutes: WEEKLY_MINUTES, resetsAt: null, resetDescription: null }
}

/**
 * The record `agy -p "/usage"` produces for a tier metered weekly only, with the Gemini pool
 * genuinely exhausted — captured from agy 1.2.11.
 */
function antigravityLimits(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: weeklyWindow(100),
    buckets: [
      { name: 'Gemini Models', ...weeklyWindow(100) },
      { name: 'Claude and GPT models', ...weeklyWindow(0) }
    ],
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    ...overrides
  }
}

describe('Antigravity status-bar segment', () => {
  it('renders Gemini model pools as GM · WL and hides external Claude/GPT models from the status bar', async () => {
    // Why: Antigravity hides external model pools (Claude and GPT) from the status bar,
    // formatting first-party Gemini pools concisely as GM · WL / GM · 5H.
    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment p={antigravityLimits()} compact={false} display="used" mode="verbose" />
    )

    expect(markup).toContain('GM · WL')
    expect(markup).toContain('100%')
    expect(markup).not.toContain('Gemini Models')
    expect(markup).not.toContain('Claude and GPT models')
  })

  it('formats Gemini 5h and weekly limit buckets as GM · 5H and GM · WL', async () => {
    const { ProviderSegment } = await import('./StatusBar')
    const limits: ProviderRateLimits = {
      ...antigravityLimits(),
      buckets: [
        {
          name: 'Gemini Models · 5h Limit Remaining',
          usedPercent: 40,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: null
        },
        {
          name: 'Gemini Models · Weekly Limit Remaining',
          usedPercent: 25,
          windowMinutes: 10_080,
          resetsAt: null,
          resetDescription: null
        },
        {
          name: 'Claude and GPT models · Weekly Limit Remaining',
          usedPercent: 80,
          windowMinutes: 10_080,
          resetsAt: null,
          resetDescription: null
        }
      ]
    }
    const markup = renderToStaticMarkup(
      <ProviderSegment p={limits} compact={false} display="used" mode="verbose" />
    )

    expect(markup).toContain('GM · 5H')
    expect(markup).toContain('40%')
    expect(markup).toContain('GM · WL')
    expect(markup).toContain('25%')
    expect(markup).not.toContain('Gemini Models')
    expect(markup).not.toContain('Claude and GPT models')
    expect(markup).not.toContain('80%')
  })

  it('prioritizes Gemini models for tightest section in compact mode ignoring external models', async () => {
    const { ProviderSegment } = await import('./StatusBar')
    const limits: ProviderRateLimits = {
      ...antigravityLimits(),
      buckets: [
        {
          name: 'Gemini Models · Weekly Limit Remaining',
          usedPercent: 30,
          windowMinutes: 10_080,
          resetsAt: null,
          resetDescription: null
        },
        {
          name: 'Claude and GPT models',
          usedPercent: 95,
          windowMinutes: 10_080,
          resetsAt: null,
          resetDescription: null
        }
      ]
    }
    const markup = renderToStaticMarkup(
      <ProviderSegment p={limits} compact={true} display="used" mode="compact" />
    )

    expect(markup).toContain('30%')
    expect(markup).not.toContain('95%')
    expect(markup).not.toContain('Claude and GPT models')
  })

  it('shows the weekly window when a tier reports no session pool', async () => {
    // Why: the verbose fallback chain was `session ?? monthly`, so a weekly-only provider with a
    // real limit rendered an empty segment.
    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment
        p={antigravityLimits({ buckets: [] })}
        compact={false}
        display="used"
        mode="verbose"
      />
    )

    expect(markup).toContain('100%')
  })

  it('still renders a reading when only the weekly window is known', async () => {
    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment
        p={antigravityLimits({ buckets: undefined })}
        compact={false}
        display="used"
        mode="verbose"
      />
    )

    expect(markup).toContain('100%')
  })

  it('does not widen the allowlist for providers that rely on it', async () => {
    // Why: Gemini's experimental buckets are still filtered; only providers whose buckets are the
    // whole meter bypass the allowlist.
    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment
        p={{
          provider: 'gemini',
          session: weeklyWindow(12),
          weekly: null,
          buckets: [
            { name: 'Pro', ...weeklyWindow(30) },
            { name: 'Some Experimental Model', ...weeklyWindow(80) }
          ],
          updatedAt: Date.now(),
          error: null,
          status: 'ok'
        }}
        compact={false}
        display="used"
        mode="verbose"
      />
    )

    expect(markup).toContain('Pro')
    expect(markup).not.toContain('Some Experimental Model')
  })
})
