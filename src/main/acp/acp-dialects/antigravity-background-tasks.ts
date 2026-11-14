import type { AgentJournalToolCallItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isSettledBackgroundTaskState } from '../../../shared/native-chat/input/task-lists/native-chat-background-task-row'
import type { NativeChatBackgroundTaskBlock } from '../../../shared/native-chat/native-chat-types'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpBackgroundTaskUpdate } from './acp-dialect'

const BG_STARTED_RE = /Tool is running as a background task with task id:\s*([^\r\n]+)/i
const BG_DESC_RE = /Task Description:\s*([^\r\n]+)/i
const BG_LOG_RE = /Task logs are available at:\s*(?:file:\/\/\/)?([^\r\n]+)/i

const BG_RESULT_RE =
  /Task id "(?<taskId>[^"]+)" finished with result:\s*(?:Command exited with code (?<code>\d+)|(?<status>[^\r\n]+))/i
const BG_STATUS_RE =
  /Task:\s*(?<taskId>[^\r\n]+)\s*\r?\n\s*Status:\s*(?<status>RUNNING|COMPLETED|DONE|FAILED|ERROR|KILLED|STOPPED)/i

function extractText(update: ToolCallUpdate): string {
  const parts: string[] = []
  if (typeof update.rawOutput === 'string') {
    parts.push(update.rawOutput)
  } else if (update.rawOutput && typeof update.rawOutput === 'object') {
    const obj = update.rawOutput as Record<string, unknown>
    for (const key of ['stdout', 'combinedOutput', 'combined_output', 'output']) {
      if (typeof obj[key] === 'string') {
        parts.push(obj[key] as string)
      }
    }
  }
  if (Array.isArray(update.content)) {
    for (const block of update.content) {
      if (block && typeof block === 'object' && 'content' in block) {
        const inner = (block as { content: unknown }).content
        if (inner && typeof inner === 'object' && 'text' in inner) {
          const text = (inner as { text: unknown }).text
          if (typeof text === 'string') {
            parts.push(text)
          }
        }
      }
    }
  }
  return parts.join('\n')
}

export function antigravityToolBackgroundTasks(
  update: ToolCallUpdate,
  tool: AgentJournalToolCallItem
): AcpBackgroundTaskUpdate[] {
  const text = extractText(update)

  // 1. Task backgrounded / started
  const startMatch = BG_STARTED_RE.exec(text)
  if (startMatch) {
    const taskId = startMatch[1]!.trim()
    const descMatch = BG_DESC_RE.exec(text)
    const logMatch = BG_LOG_RE.exec(text)
    const label = descMatch?.[1]?.trim() || update.title?.trim() || tool.name
    return [
      {
        taskId,
        state: 'working',
        kind: 'command',
        ...(label ? { label } : {}),
        ...(logMatch ? { outputFile: logMatch[1]!.trim() } : {}),
        parentToolUseId: update.toolCallId
      }
    ]
  }

  // 2. Task completion via result banner
  const resultMatch = BG_RESULT_RE.exec(text)
  if (resultMatch?.groups) {
    const { taskId, code, status } = resultMatch.groups
    const exitZero = code === '0' || status?.toLowerCase() === 'completed'
    const state: NativeChatBackgroundTaskBlock['state'] = exitZero ? 'done' : 'blocked'
    return [
      {
        taskId: taskId!.trim(),
        state,
        summary: code ? `Command exited with code ${code}.` : status || ''
      }
    ]
  }

  // 3. Task status check from manage_task output
  const statusMatch = BG_STATUS_RE.exec(text)
  if (statusMatch?.groups) {
    const { taskId, status } = statusMatch.groups
    const normalized = status!.toUpperCase()
    const state: NativeChatBackgroundTaskBlock['state'] =
      normalized === 'RUNNING'
        ? 'working'
        : normalized === 'COMPLETED' || normalized === 'DONE'
          ? 'done'
          : normalized === 'KILLED' || normalized === 'STOPPED'
            ? 'idle'
            : 'blocked'
    return [
      {
        taskId: taskId!.trim(),
        state
      }
    ]
  }

  // 4. Explicit manage_task kill action
  if (
    tool.name === 'manage_task' &&
    update.status === 'completed' &&
    tool.input &&
    typeof tool.input === 'object'
  ) {
    const input = tool.input as { Action?: string; TaskId?: string }
    if (input.Action === 'kill' && input.TaskId) {
      return [
        {
          taskId: input.TaskId.trim(),
          state: 'idle'
        }
      ]
    }
  }

  return []
}

export function isTaskSettled(state: NativeChatBackgroundTaskBlock['state']): boolean {
  return isSettledBackgroundTaskState(state)
}
