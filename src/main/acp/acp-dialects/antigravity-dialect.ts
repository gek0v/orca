import type { AcpDialect } from './acp-dialect'

/**
 * Chromium writes this line to stdout when opening an OAuth URL in an existing
 * browser session. It must be dropped so JSON-RPC parsing remains intact.
 */
export const CHROMIUM_EXISTING_SESSION_LINE = 'Opening in existing browser session.'

export function isAntigravityIgnoredStdoutLine(line: string): boolean {
  return line.trim() === CHROMIUM_EXISTING_SESSION_LINE
}

export type AntigravityEffort = 'low' | 'medium' | 'high'

export type AntigravityModelEffort = {
  baseId: string
  effort: AntigravityEffort
}

const MODEL_VARIANTS: Record<string, Partial<Record<AntigravityEffort, string>>> = {
  'gemini-3.8-flash': {
    low: 'gemini-3.8-flash-low',
    medium: 'gemini-3.8-flash-medium',
    high: 'gemini-3.8-flash-high'
  },
  'gemini-3.7-flash': {
    low: 'gemini-3.7-flash-low',
    medium: 'gemini-3.7-flash-medium',
    high: 'gemini-3.7-flash-high'
  },
  'gemini-3.6-flash': {
    low: 'gemini-3.6-flash-low',
    medium: 'gemini-3.6-flash-medium',
    high: 'gemini-3.6-flash-high'
  },
  'gemini-3.1-pro': {
    low: 'gemini-3.1-pro-low',
    high: 'gemini-pro-agent'
  }
}

/**
 * Normalizes an effort-qualified model ID into a base model ID and its effort tier.
 */
export function collapseAntigravityModelEffort(modelId: string): AntigravityModelEffort | null {
  const trimmed = modelId.trim()
  if (trimmed === 'gemini-pro-agent') {
    return { baseId: 'gemini-3.1-pro', effort: 'high' }
  }
  for (const [baseId, variants] of Object.entries(MODEL_VARIANTS)) {
    for (const [effort, variantId] of Object.entries(variants)) {
      if (variantId === trimmed) {
        return { baseId, effort: effort as AntigravityEffort }
      }
    }
  }
  return null
}

/**
 * Resolves a canonical base model ID and an Orca effort pick to the exact server model ID.
 */
export function resolveAntigravityModelEffortId(
  baseId: string,
  effort: string | undefined
): string {
  const variants = MODEL_VARIANTS[baseId]
  if (!variants) {
    return baseId
  }
  const normalizedEffort: AntigravityEffort =
    effort === 'low' || effort === 'minimal'
      ? 'low'
      : effort === 'high' || effort === 'xhigh' || effort === 'max'
        ? 'high'
        : 'medium'

  return variants[normalizedEffort] ?? variants.high ?? variants.medium ?? variants.low ?? baseId
}

export const ANTIGRAVITY_ACP_DIALECT: AcpDialect = {
  failedTurnText(stopReason: string): string {
    if (stopReason === 'rate_limit' || stopReason === 'quota_exhausted') {
      return 'Antigravity quota exhausted or rate limit reached. Switch accounts or retry later.'
    }
    return 'Turn failed'
  }
}
