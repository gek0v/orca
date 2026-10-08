import { describe, expect, it } from 'vitest'
import { antigravityToolName, antigravityToolBackgroundTasks } from './antigravity-background-tasks'
import type { AgentJournalToolCallItem } from '../../../shared/agent-session-journal-types'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'

describe('antigravityToolName', () => {
  it('maps known Antigravity tool names to friendly display titles', () => {
    expect(antigravityToolName({ toolCallId: 't1', name: 'invoke_subagent' })).toBe('Subagent')
    expect(antigravityToolName({ toolCallId: 't2', name: 'manage_subagents' })).toBe(
      'Manage Subagents'
    )
    expect(antigravityToolName({ toolCallId: 't3', name: 'send_message' })).toBe('Message Subagent')
    expect(antigravityToolName({ toolCallId: 't4', name: 'define_subagent' })).toBe(
      'Define Subagent'
    )
    expect(antigravityToolName({ toolCallId: 't5', name: 'run_command' })).toBe('Terminal Command')
    expect(antigravityToolName({ toolCallId: 't6', name: 'manage_task' })).toBe('Background Task')
    expect(antigravityToolName({ toolCallId: 't7', name: 'schedule' })).toBe('Schedule Task')
    expect(antigravityToolName({ toolCallId: 't8', name: 'view_file' })).toBe('View File')
    expect(antigravityToolName({ toolCallId: 't9', name: 'write_to_file' })).toBe('Write File')
    expect(antigravityToolName({ toolCallId: 't10', name: 'replace_file_content' })).toBe(
      'Edit File'
    )
  })

  it('falls back to title or name for unknown tools', () => {
    expect(
      antigravityToolName({ toolCallId: 't1', name: 'custom_tool', title: 'Custom Tool Title' })
    ).toBe('Custom Tool Title')
    expect(antigravityToolName({ toolCallId: 't2', name: 'custom_tool' })).toBe('custom_tool')
    expect(antigravityToolName({ toolCallId: 't3', title: 'Only Title' })).toBe('Only Title')
    expect(antigravityToolName({ toolCallId: 't4' })).toBeUndefined()
  })
})

describe('antigravityToolBackgroundTasks', () => {
  const dummyTool: AgentJournalToolCallItem = {
    kind: 'tool-call',
    callId: 'tool-call-1',
    name: 'invoke_subagent',
    input: {},
    state: 'completed'
  }

  it('maps invoke_subagent with subagents array to subagent tasks', () => {
    const update: ToolCallUpdate = {
      toolCallId: 'call-sub',
      status: 'in_progress'
    }
    const tool: AgentJournalToolCallItem = {
      ...dummyTool,
      name: 'invoke_subagent',
      input: {
        Subagents: [
          { Role: 'Code Reviewer', TypeName: 'reviewer' },
          { TypeName: 'researcher', Prompt: 'Search docs' }
        ]
      }
    }

    const tasks = antigravityToolBackgroundTasks(update, tool)
    expect(tasks).toHaveLength(2)
    expect(tasks[0]).toEqual({
      taskId: 'call-sub-subagent-0',
      kind: 'agent',
      state: 'working',
      fallbackLabel: 'Code Reviewer',
      fallbackKind: 'agent',
      parentToolUseId: 'call-sub'
    })
    expect(tasks[1]).toEqual({
      taskId: 'call-sub-subagent-1',
      kind: 'agent',
      state: 'working',
      fallbackLabel: 'researcher',
      fallbackKind: 'agent',
      parentToolUseId: 'call-sub'
    })
  })

  it('creates single subagent task when input is empty or invalid', () => {
    const update: ToolCallUpdate = {
      toolCallId: 'call-empty',
      status: 'completed'
    }
    const tool: AgentJournalToolCallItem = {
      ...dummyTool,
      name: 'invoke_subagent',
      input: null
    }

    const tasks = antigravityToolBackgroundTasks(update, tool)
    expect(tasks).toEqual([
      {
        taskId: 'call-empty-subagent',
        kind: 'agent',
        state: 'done',
        fallbackLabel: 'Subagent',
        fallbackKind: 'agent',
        parentToolUseId: 'call-empty'
      }
    ])
  })

  it('projects run_command daemon processes into command background tasks', () => {
    const update: ToolCallUpdate = {
      toolCallId: 'call-cmd',
      status: 'in_progress'
    }
    const tool: AgentJournalToolCallItem = {
      ...dummyTool,
      name: 'run_command',
      input: {
        CommandLine: 'npm run dev',
        IsDaemon: true,
        toolSummary: 'Start Vite dev server'
      }
    }

    const tasks = antigravityToolBackgroundTasks(update, tool)
    expect(tasks).toEqual([
      {
        taskId: 'call-cmd-daemon',
        kind: 'command',
        state: 'working',
        fallbackLabel: 'Start Vite dev server',
        fallbackKind: 'command',
        parentToolUseId: 'call-cmd'
      }
    ])
  })

  it('ignores run_command non-daemon tasks', () => {
    const update: ToolCallUpdate = {
      toolCallId: 'call-cmd-normal',
      status: 'completed'
    }
    const tool: AgentJournalToolCallItem = {
      ...dummyTool,
      name: 'run_command',
      input: {
        CommandLine: 'git status',
        IsDaemon: false
      }
    }

    expect(antigravityToolBackgroundTasks(update, tool)).toEqual([])
  })

  it('projects schedule calls into background tasks', () => {
    const update: ToolCallUpdate = {
      toolCallId: 'call-sched',
      status: 'failed'
    }
    const tool: AgentJournalToolCallItem = {
      ...dummyTool,
      name: 'schedule',
      input: {
        DurationSeconds: 300,
        Prompt: 'Check compilation status'
      }
    }

    const tasks = antigravityToolBackgroundTasks(update, tool)
    expect(tasks).toEqual([
      {
        taskId: 'call-sched-schedule',
        kind: 'command',
        state: 'blocked',
        fallbackLabel: 'Check compilation status',
        fallbackKind: 'command',
        parentToolUseId: 'call-sched'
      }
    ])
  })

  it('handles kill actions in manage_task and manage_subagents', () => {
    const update: ToolCallUpdate = { toolCallId: 'kill-call', status: 'completed' }
    const killTaskTool: AgentJournalToolCallItem = {
      ...dummyTool,
      name: 'manage_task',
      input: { Action: 'kill', TaskId: 'task-123' }
    }
    expect(antigravityToolBackgroundTasks(update, killTaskTool)).toEqual([
      {
        taskId: 'task-123',
        state: 'idle',
        fallbackKind: 'command'
      }
    ])

    const killSubagentsTool: AgentJournalToolCallItem = {
      ...dummyTool,
      name: 'manage_subagents',
      input: { Action: 'kill', ConversationIds: ['agent-1', 'agent-2'] }
    }
    expect(antigravityToolBackgroundTasks(update, killSubagentsTool)).toEqual([
      { taskId: 'agent-1', state: 'idle', fallbackKind: 'agent' },
      { taskId: 'agent-2', state: 'idle', fallbackKind: 'agent' }
    ])

    const killAllTool: AgentJournalToolCallItem = {
      ...dummyTool,
      name: 'manage_subagents',
      input: { Action: 'kill_all', ConversationIds: ['agent-all-1'] }
    }
    expect(antigravityToolBackgroundTasks(update, killAllTool)).toEqual([
      { taskId: 'agent-all-1', state: 'idle', fallbackKind: 'agent' }
    ])
  })
})
