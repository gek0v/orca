import type { AntigravityToolCategory } from '../../shared/antigravity-usage-types'
import { estimateAntigravityCostUsd } from './antigravity-model-pricing'
import type { AntigravityUsageParsedEvent, AntigravityUsageParsedToolCall } from './types'

export type AntigravityTranscriptContext = {
  sessionId: string
  cwd: string | null
  model: string | null
}

type TranscriptStep = {
  step_index?: unknown
  source?: unknown
  type?: unknown
  status?: unknown
  created_at?: unknown
  input_tokens?: unknown
  cache_read_tokens?: unknown
  output_tokens?: unknown
  tool_calls?: unknown
}

export function classifyAntigravityTool(toolName: string): AntigravityToolCategory {
  switch (toolName) {
    case 'run_command':
      return 'terminal'
    case 'replace_file_content':
    case 'write_to_file':
      return 'edit'
    case 'view_file':
      return 'read'
    case 'search_web':
    case 'read_url_content':
      return 'search'
    case 'invoke_subagent':
    case 'send_message':
    case 'define_subagent':
      return 'subagent'
    default:
      return 'other'
  }
}

export function normalizeTargetFile(rawFile: string, cwd: string | null): string {
  let clean = rawFile.trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/')
  if (cwd) {
    const cleanCwd = cwd.trim().replace(/\\/g, '/').replace(/\/+$/, '')
    if (clean.toLowerCase().startsWith(`${cleanCwd.toLowerCase()}/`)) {
      clean = clean.slice(cleanCwd.length + 1)
    }
  }
  return clean
}

function extractCwdFromToolCalls(toolCalls: unknown): string | null {
  if (!Array.isArray(toolCalls)) {
    return null
  }
  for (const call of toolCalls) {
    if (typeof call === 'object' && call !== null && 'args' in call) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Checked object with args property, safe property lookup below.
      const args = call.args as Record<string, unknown> | undefined
      if (typeof args?.Cwd === 'string' && args.Cwd.trim()) {
        return args.Cwd.trim().replace(/^"(.*)"$/, '$1')
      }
      if (typeof args?.TargetFile === 'string' && args.TargetFile.trim()) {
        const file = args.TargetFile.trim().replace(/^"(.*)"$/, '$1')
        const parts = file.split(/[\\/]/)
        if (parts.length > 1) {
          parts.pop()
          return parts.join('/')
        }
      }
    }
  }
  return null
}

function extractToolCalls(
  toolCalls: unknown,
  cwd: string | null
): AntigravityUsageParsedToolCall[] {
  if (!Array.isArray(toolCalls)) {
    return []
  }
  const parsedCalls: AntigravityUsageParsedToolCall[] = []
  for (const call of toolCalls) {
    if (typeof call === 'object' && call !== null && 'name' in call) {
      const name = typeof call.name === 'string' ? call.name.trim() : 'unknown'
      const category = classifyAntigravityTool(name)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Checked object with args property, safe property lookup below.
      const args = (typeof call === 'object' && 'args' in call ? call.args : undefined) as
        | Record<string, unknown>
        | undefined
      let targetFile: string | null = null
      let isEdit = false
      let isRead = false

      if (category === 'read' && typeof args?.AbsolutePath === 'string') {
        targetFile = normalizeTargetFile(args.AbsolutePath, cwd)
        isRead = true
      } else if (category === 'edit' && typeof args?.TargetFile === 'string') {
        targetFile = normalizeTargetFile(args.TargetFile, cwd)
        isEdit = true
      }

      parsedCalls.push({
        category,
        toolName: name,
        targetFile,
        isEdit,
        isRead
      })
    }
  }
  return parsedCalls
}

export function parseAntigravityTranscriptLine(
  line: string,
  context: AntigravityTranscriptContext
): AntigravityUsageParsedEvent | null {
  if (!line.trim()) {
    return null
  }

  let step: TranscriptStep
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: JSON parse output is guarded and validated field-by-field below.
    step = JSON.parse(line) as TranscriptStep
  } catch {
    return null
  }

  if (typeof step.created_at !== 'string' || !step.created_at) {
    return null
  }

  // Update cwd if tool call has a path and cwd is not yet set
  if (!context.cwd && step.tool_calls) {
    const discoveredCwd = extractCwdFromToolCalls(step.tool_calls)
    if (discoveredCwd) {
      context.cwd = discoveredCwd
    }
  }

  // Count turns from model planner responses or user inputs
  const isModelResponse = step.source === 'MODEL' && step.type === 'PLANNER_RESPONSE'
  const isUserInput = step.source === 'USER_EXPLICIT' && step.type === 'USER_INPUT'

  if (!isModelResponse && !isUserInput) {
    return null
  }

  const inputTokens = typeof step.input_tokens === 'number' ? step.input_tokens : 0
  const cachedInputTokens =
    typeof step.cache_read_tokens === 'number' ? step.cache_read_tokens : 0
  const outputTokens = typeof step.output_tokens === 'number' ? step.output_tokens : 0
  const totalTokens = inputTokens + outputTokens

  const estimatedCostUsd = estimateAntigravityCostUsd(context.model, {
    inputTokens,
    cachedInputTokens,
    outputTokens
  })

  const toolCalls = step.tool_calls ? extractToolCalls(step.tool_calls, context.cwd) : []

  return {
    sessionId: context.sessionId,
    timestamp: step.created_at,
    model: context.model,
    cwd: context.cwd,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens,
    estimatedCostUsd,
    toolCalls
  }
}
