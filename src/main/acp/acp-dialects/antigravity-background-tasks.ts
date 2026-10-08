import { z } from 'zod'
import type { AgentJournalToolCallItem } from '../../../shared/agent-session-journal-types'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpBackgroundTaskUpdate } from './acp-dialect'

export function antigravityToolName(update: ToolCallUpdate): string | undefined {
  const name = update.name?.trim()
  if (!name) {
    return update.title ?? undefined
  }
  switch (name) {
    case 'invoke_subagent':
      return 'Subagent'
    case 'manage_subagents':
      return 'Manage Subagents'
    case 'send_message':
      return 'Message Subagent'
    case 'define_subagent':
      return 'Define Subagent'
    case 'run_command':
      return 'Terminal Command'
    case 'manage_task':
      return 'Background Task'
    case 'schedule':
      return 'Schedule Task'
    case 'view_file':
      return 'View File'
    case 'write_to_file':
      return 'Write File'
    case 'replace_file_content':
      return 'Edit File'
    default:
      return update.title ?? name
  }
}

const subagentsInputSchema = z.looseObject({
  Subagents: z
    .array(
      z.looseObject({
        Role: z.string().optional(),
        TypeName: z.string().optional(),
        Prompt: z.string().optional()
      })
    )
    .optional()
})

const commandInputSchema = z.looseObject({
  CommandLine: z.string().optional(),
  IsDaemon: z.boolean().optional(),
  toolSummary: z.string().optional(),
  toolAction: z.string().optional()
})

const scheduleInputSchema = z.looseObject({
  DurationSeconds: z.number().optional(),
  CronExpression: z.string().optional(),
  Prompt: z.string().optional()
})

const manageTaskSchema = z.looseObject({
  Action: z.string().optional(),
  TaskId: z.string().optional(),
  ConversationIds: z.array(z.string()).optional()
})

export function antigravityToolBackgroundTasks(
  update: ToolCallUpdate,
  tool: AgentJournalToolCallItem
): AcpBackgroundTaskUpdate[] {
  const status = update.status
  const state = status === 'completed' ? 'done' : status === 'failed' ? 'blocked' : 'working'

  if (tool.name === 'invoke_subagent') {
    const input = subagentsInputSchema.safeParse(tool.input)
    const subagents = input.success ? (input.data.Subagents ?? []) : []
    if (subagents.length === 0) {
      return [
        {
          taskId: `${update.toolCallId}-subagent`,
          kind: 'agent',
          state,
          fallbackLabel: 'Subagent',
          fallbackKind: 'agent',
          parentToolUseId: update.toolCallId
        }
      ]
    }
    return subagents.map((subagent, index) => ({
      taskId: `${update.toolCallId}-subagent-${index}`,
      kind: 'agent' as const,
      state,
      fallbackLabel: subagent.Role ?? subagent.TypeName ?? 'Subagent',
      fallbackKind: 'agent' as const,
      parentToolUseId: update.toolCallId
    }))
  }

  if (tool.name === 'run_command') {
    const input = commandInputSchema.safeParse(tool.input)
    if (input.success && input.data.IsDaemon) {
      return [
        {
          taskId: `${update.toolCallId}-daemon`,
          kind: 'command',
          state,
          fallbackLabel:
            input.data.toolSummary ?? input.data.CommandLine?.slice(0, 50) ?? 'Daemon Process',
          fallbackKind: 'command',
          parentToolUseId: update.toolCallId
        }
      ]
    }
  }

  if (tool.name === 'schedule') {
    const input = scheduleInputSchema.safeParse(tool.input)
    const label = input.success
      ? (input.data.Prompt?.slice(0, 50) ??
        (input.data.DurationSeconds ? `Timer (${input.data.DurationSeconds}s)` : 'Scheduled Job'))
      : 'Schedule'
    return [
      {
        taskId: `${update.toolCallId}-schedule`,
        kind: 'command',
        state,
        fallbackLabel: label,
        fallbackKind: 'command',
        parentToolUseId: update.toolCallId
      }
    ]
  }

  if (tool.name === 'manage_task' || tool.name === 'manage_subagents') {
    const input = manageTaskSchema.safeParse(tool.input)
    if (input.success && (input.data.Action === 'kill' || input.data.Action === 'kill_all')) {
      const updates: AcpBackgroundTaskUpdate[] = []
      if (input.data.TaskId) {
        updates.push({
          taskId: input.data.TaskId,
          state: 'idle',
          fallbackKind: 'command'
        })
      }
      if (input.data.ConversationIds) {
        for (const id of input.data.ConversationIds) {
          updates.push({
            taskId: id,
            state: 'idle',
            fallbackKind: 'agent'
          })
        }
      }
      return updates
    }
  }

  return []
}
