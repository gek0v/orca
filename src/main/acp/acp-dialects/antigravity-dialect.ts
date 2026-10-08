import { z } from 'zod'
import type { AcpDialect, AcpOptionWrite } from './acp-dialect'
import { antigravityToolName, antigravityToolBackgroundTasks } from './antigravity-background-tasks'
import type { SessionConfigOption, SessionModelState } from '../generated/acp-protocol.generated'
import type {
  AgentSessionModelOption,
  AgentSessionOptionChoice,
  AgentSessionOptionsResult
} from '../../../shared/agent-session-wire'

/**
 * Chromium writes this line to stdout when opening an OAuth URL in an existing
 * browser session. It must be dropped so JSON-RPC parsing remains intact.
 */
export const CHROMIUM_EXISTING_SESSION_LINE = 'Opening in existing browser session.'

export function isAntigravityIgnoredStdoutLine(line: string): boolean {
  return line.trim() === CHROMIUM_EXISTING_SESSION_LINE
}

const antigravityModelsSchema = z.looseObject({
  currentModelId: z.string().optional(),
  availableModels: z
    .array(
      z.looseObject({
        modelId: z.string(),
        _meta: z
          .looseObject({ totalContextTokens: z.number().int().positive().optional() })
          .optional()
      })
    )
    .optional()
})

export function antigravityContextWindow(models: unknown): number | undefined {
  const parsed = antigravityModelsSchema.safeParse(models)
  if (!parsed.success) {
    return undefined
  }
  const { currentModelId, availableModels = [] } = parsed.data
  const current = availableModels.find((model) => model.modelId === currentModelId)
  if (current?._meta?.totalContextTokens) {
    return current._meta.totalContextTokens
  }
  const modelId = currentModelId ?? availableModels[0]?.modelId
  if (!modelId) {
    return undefined
  }
  const lower = modelId.toLowerCase()
  if (lower.includes('pro')) {
    return 2_097_152
  }
  if (lower.includes('flash')) {
    return 1_048_576
  }
  return 1_048_576
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

function isAntigravityEffort(value: string): value is AntigravityEffort {
  return value === 'low' || value === 'medium' || value === 'high'
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
      if (variantId === trimmed && isAntigravityEffort(effort)) {
        return { baseId, effort }
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

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'gemini-3.7-flash': 'Gemini 3.7 Flash',
  'gemini-3.6-flash': 'Gemini 3.6 Flash',
  'gemini-3.1-pro': 'Gemini 3.1 Pro'
}

const EFFORT_CHOICES: Record<AntigravityEffort, AgentSessionOptionChoice> = {
  low: { value: 'low', label: 'Low', description: 'Fast responses with minimal reasoning' },
  medium: { value: 'medium', label: 'Medium', description: 'Balanced reasoning effort' },
  high: { value: 'high', label: 'High', description: 'Deep, extended reasoning' }
}

export function normalizeAntigravityOptions(raw: {
  configOptions: SessionConfigOption[]
  models: SessionModelState | null
}): Pick<AgentSessionOptionsResult, 'models' | 'current'> | undefined {
  const hasNativeThoughtLevel = raw.configOptions.some(
    (opt) =>
      opt.type === 'select' && (opt.category === 'thought_level' || opt.id === 'thought_level')
  )
  if (hasNativeThoughtLevel || !raw.models || raw.models.availableModels.length === 0) {
    return undefined
  }

  const currentRawId = raw.models.currentModelId ?? raw.models.availableModels[0]?.modelId ?? ''
  const currentCollapsed = currentRawId ? collapseAntigravityModelEffort(currentRawId) : null
  const currentBaseId = currentCollapsed ? currentCollapsed.baseId : currentRawId
  const currentEffort = currentCollapsed ? currentCollapsed.effort : undefined

  const grouped = new Map<
    string,
    {
      id: string
      label: string
      description?: string
      efforts: Set<AntigravityEffort>
    }
  >()

  for (const model of raw.models.availableModels) {
    const collapsed = collapseAntigravityModelEffort(model.modelId)
    if (collapsed) {
      const existing = grouped.get(collapsed.baseId)
      if (existing) {
        existing.efforts.add(collapsed.effort)
      } else {
        grouped.set(collapsed.baseId, {
          id: collapsed.baseId,
          label:
            MODEL_DISPLAY_NAMES[collapsed.baseId] ??
            model.name.replace(/\s*\((?:Low|Medium|High)\s*Reasoning\)/i, '').trim(),
          ...(model.description ? { description: model.description } : {}),
          efforts: new Set([collapsed.effort])
        })
      }
    } else {
      grouped.set(model.modelId, {
        id: model.modelId,
        label: model.name,
        ...(model.description ? { description: model.description } : {}),
        efforts: new Set()
      })
    }
  }

  const models: AgentSessionModelOption[] = Array.from(grouped.values()).map((entry) => {
    const isDefault = entry.id === currentBaseId
    const efforts: AgentSessionOptionChoice[] = (['low', 'medium', 'high'] as const)
      .filter((level) => entry.efforts.has(level))
      .map((level) => EFFORT_CHOICES[level])

    return {
      id: entry.id,
      label: entry.label,
      ...(entry.description ? { description: entry.description } : {}),
      isDefault,
      efforts,
      ...(efforts.length > 0
        ? { defaultEffort: isDefault && currentEffort ? currentEffort : efforts[0]?.value }
        : {})
    }
  })

  return {
    models,
    current: {
      model: currentBaseId,
      ...(currentEffort ? { effort: currentEffort } : {}),
      confirmed: [...(currentBaseId ? ['model'] : []), ...(currentEffort ? ['effort'] : [])]
    }
  }
}

export function resolveAntigravityOptionWrite(
  key: string,
  value: string,
  raw: {
    configOptions: SessionConfigOption[]
    models: SessionModelState | null
  }
): AcpOptionWrite | undefined {
  const hasNativeThoughtLevel = raw.configOptions.some(
    (opt) =>
      opt.type === 'select' && (opt.category === 'thought_level' || opt.id === 'thought_level')
  )
  if (hasNativeThoughtLevel || !raw.models) {
    return undefined
  }

  const currentRawId = raw.models.currentModelId ?? ''
  const currentCollapsed = currentRawId ? collapseAntigravityModelEffort(currentRawId) : null

  if (key === 'model') {
    const currentEffort = currentCollapsed?.effort ?? 'high'
    const targetModelId = resolveAntigravityModelEffortId(value, currentEffort)
    return { method: 'model', modelId: targetModelId }
  }

  if (key === 'effort') {
    const currentBaseId = currentCollapsed?.baseId ?? currentRawId
    const targetModelId = resolveAntigravityModelEffortId(currentBaseId, value)
    return { method: 'model', modelId: targetModelId }
  }

  return undefined
}

export const ANTIGRAVITY_ACP_DIALECT: AcpDialect = {
  ignoredStdoutLine: isAntigravityIgnoredStdoutLine,
  toolName: antigravityToolName,
  toolBackgroundTasks: antigravityToolBackgroundTasks,
  contextWindow: antigravityContextWindow,
  normalizeOptions: normalizeAntigravityOptions,
  resolveOptionWrite: resolveAntigravityOptionWrite,
  failedTurnText(stopReason: string): string {
    if (stopReason === 'rate_limit' || stopReason === 'quota_exhausted') {
      return 'Antigravity quota exhausted or rate limit reached. Switch accounts or retry later.'
    }
    return 'Turn failed'
  }
}
