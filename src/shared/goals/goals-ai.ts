import { z } from 'zod'

export const GoalAiGeneratedSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  subtasks: z.array(z.string().min(1)).min(1),
  validationCommand: z.string().optional()
})

export type GoalAiGenerated = z.infer<typeof GoalAiGeneratedSchema>

export function buildGoalAiPrompt(userPrompt: string): string {
  return [
    'Act as an expert software architect and technical lead.',
    'Deconstruct the following engineering goal or feature request into a structured goal definition with concrete, sequential subtasks.',
    '',
    `User Request: "${userPrompt.trim()}"`,
    '',
    'Output MUST be a valid JSON object matching this schema:',
    '{',
    '  "title": "<Concise goal title>",',
    '  "description": "<Optional detailed description or acceptance criteria>",',
    '  "subtasks": [',
    '    "<Actionable step 1>",',
    '    "<Actionable step 2>",',
    '    "<Actionable step 3>"',
    '  ],',
    '  "validationCommand": "<Shell command to automatically verify completion, e.g. pnpm test, or empty if unknown>"',
    '}',
    '',
    'Return ONLY the JSON object, without extra conversational text.'
  ].join('\n')
}

export function parseGoalAiResponse(raw: string, fallbackPrompt?: string): GoalAiGenerated {
  const trimmed = raw.trim()

  // Match JSON within markdown code blocks or curly braces
  const jsonMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed)
  const candidate = jsonMatch ? jsonMatch[1].trim() : trimmed

  try {
    const parsed = JSON.parse(candidate)
    const result = GoalAiGeneratedSchema.safeParse(parsed)
    if (result.success) {
      return result.data
    }
  } catch {
    // Attempt fallback heuristic extraction
  }

  // Heuristic extraction if LLM outputs text/markdown list
  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const subtasks: string[] = []
  let extractedTitle: string | null = null
  let description: string | undefined

  for (const line of lines) {
    const listMatch = /^[-*•\d.]+\s*(.+)/.exec(line)
    if (listMatch) {
      subtasks.push(listMatch[1].trim())
    } else if (!extractedTitle && !line.startsWith('#')) {
      extractedTitle = line.trim()
    } else if (!extractedTitle && line.startsWith('#')) {
      extractedTitle = line.replace(/^#+\s*/, '').trim()
    } else if (!description) {
      description = line
    }
  }

  const finalTitle = extractedTitle || fallbackPrompt?.trim() || 'Nuevo Objetivo'

  return {
    title: finalTitle,
    description: description || undefined,
    subtasks: subtasks.length > 0 ? subtasks : ['Definir alcance e implementación'],
    validationCommand: undefined
  }
}
