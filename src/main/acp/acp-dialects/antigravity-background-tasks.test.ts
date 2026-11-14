import { describe, expect, it } from 'vitest'
import { antigravityToolBackgroundTasks } from './antigravity-background-tasks'
import { ANTIGRAVITY_ACP_DIALECT } from './antigravity-dialect'
import { AcpTimelineTranslator } from '../timeline/acp-timeline-translator'
import type { AgentJournalToolCallItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'

describe('antigravityToolBackgroundTasks', () => {
  const dummyTool: AgentJournalToolCallItem = {
    kind: 'tool-call',
    callId: 'call_1',
    name: 'run_command',
    input: { CommandLine: 'powershell Start-Sleep 3' },
    state: 'completed'
  }

  it('detects a newly backgrounded task from run_command output', () => {
    const update: ToolCallUpdate = {
      toolCallId: 'call_1',
      sessionUpdate: 'tool_call_update',
      name: 'run_command',
      status: 'completed',
      rawOutput: {
        stdout:
          'Created At: 2026-11-14T20:39:14+01:00\n' +
          'Tool is running as a background task with task id: 91fddb71/task-119\n' +
          'Task Description: powershell Start-Sleep 3\n' +
          'Task logs are available at: file:///C:/Users/Geko/logs/task-119.log\n' +
          'YOU MUST TAKE ONE OF THE FOLLOWING TWO ACTIONS: A) either proceed...'
      }
    }

    const tasks = antigravityToolBackgroundTasks(update, dummyTool)
    expect(tasks).toEqual([
      {
        taskId: '91fddb71/task-119',
        state: 'working',
        kind: 'command',
        label: 'powershell Start-Sleep 3',
        outputFile: 'C:/Users/Geko/logs/task-119.log',
        parentToolUseId: 'call_1'
      }
    ])
  })

  it('detects task completion banner with exit code 0', () => {
    const update: ToolCallUpdate = {
      toolCallId: 'call_2',
      sessionUpdate: 'tool_call_update',
      name: 'manage_task',
      status: 'completed',
      rawOutput: {
        output:
          'Task id "91fddb71/task-119" finished with result:\n' +
          'Command exited with code 0.\n\nCommand output: success'
      }
    }

    const tasks = antigravityToolBackgroundTasks(update, {
      ...dummyTool,
      name: 'manage_task'
    })
    expect(tasks).toEqual([
      {
        taskId: '91fddb71/task-119',
        state: 'done',
        summary: 'Command exited with code 0.'
      }
    ])
  })

  it('detects task failure banner with non-zero exit code', () => {
    const update: ToolCallUpdate = {
      toolCallId: 'call_3',
      sessionUpdate: 'tool_call_update',
      name: 'manage_task',
      status: 'completed',
      rawOutput: {
        stdout:
          'Task id "91fddb71/task-119" finished with result:\n' +
          'Command exited with code 1.\n\nCommand output: Error occurred'
      }
    }

    const tasks = antigravityToolBackgroundTasks(update, {
      ...dummyTool,
      name: 'manage_task'
    })
    expect(tasks).toEqual([
      {
        taskId: '91fddb71/task-119',
        state: 'blocked',
        summary: 'Command exited with code 1.'
      }
    ])
  })

  it('detects status from manage_task output', () => {
    const update: ToolCallUpdate = {
      toolCallId: 'call_4',
      sessionUpdate: 'tool_call_update',
      name: 'manage_task',
      status: 'completed',
      rawOutput: {
        combinedOutput: 'Task: 91fddb71/task-119\nStatus: RUNNING\nLog: file:///path/to/log'
      }
    }

    const tasks = antigravityToolBackgroundTasks(update, {
      ...dummyTool,
      name: 'manage_task'
    })
    expect(tasks).toEqual([
      {
        taskId: '91fddb71/task-119',
        state: 'working'
      }
    ])
  })

  it('translates background task updates through AcpTimelineTranslator', () => {
    const lane = new AcpTimelineTranslator({
      sessionId: 'session-agy',
      dialect: ANTIGRAVITY_ACP_DIALECT
    })
    lane.openPrompt('send-1', 10)

    lane.notification(
      'session/update',
      {
        sessionId: 'session-agy',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call_bg',
          name: 'run_command',
          title: 'Run task in background',
          status: 'in_progress',
          rawInput: { CommandLine: 'powershell Start-Sleep 5' }
        }
      },
      11
    )

    const events = lane.notification(
      'session/update',
      {
        sessionId: 'session-agy',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_bg',
          name: 'run_command',
          status: 'completed',
          rawOutput: {
            stdout:
              'Tool is running as a background task with task id: agy-session/task-999\n' +
              'Task Description: powershell Start-Sleep 5\n'
          }
        }
      },
      12
    )

    const taskEvent = events.find(
      (e) => e.type === 'item.update' && e.item === 'background-task:agy-session/task-999'
    )
    expect(taskEvent).toBeDefined()
    expect(taskEvent).toMatchObject({
      type: 'item.update',
      item: 'background-task:agy-session/task-999',
      body: {
        kind: 'message',
        role: 'system',
        blocks: [
          expect.anything(),
          {
            type: 'background-task',
            taskId: 'agy-session/task-999',
            state: 'working',
            label: 'powershell Start-Sleep 5'
          }
        ]
      }
    })
  })
})
