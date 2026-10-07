import { describe, it, expect } from 'vitest'
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { AntigravitySubagentRosterTracker } from './antigravity-subagent-roster'

describe('AntigravitySubagentRosterTracker', () => {
  it('creates pending subagents from invoke_subagent tool call', () => {
    let mockTime = 1000
    const tracker = new AntigravitySubagentRosterTracker({ now: () => mockTime })

    const updates: unknown[] = []
    tracker.onRosterUpdated((group) => updates.push(group))

    tracker.processStep({
      step_index: 10,
      type: 'PLANNER_RESPONSE',
      tool_calls: [
        {
          name: 'invoke_subagent',
          args: {
            Subagents: [
              {
                TypeName: 'research',
                Role: 'Codebase Explorer',
                Prompt: 'Investigate architecture'
              }
            ]
          }
        }
      ]
    })

    const groups = tracker.getGroups()
    expect(groups).toHaveLength(1)
    expect(groups[0].groupId).toBe('turn-10')
    expect(groups[0].agents).toHaveLength(1)
    expect(groups[0].agents[0].label).toBe('Codebase Explorer')
    expect(groups[0].agents[0].state).toBe('working')
    expect(groups[0].agents[0].startedAt).toBe(1000)
    expect(updates).toHaveLength(1)

    tracker.dispose()
  })

  it('binds conversation ID and transcript URI from step result', () => {
    let mockTime = 2000
    const tracker = new AntigravitySubagentRosterTracker({ now: () => mockTime })

    // 1. Tool call
    tracker.processStep({
      step_index: 5,
      type: 'PLANNER_RESPONSE',
      tool_calls: [
        {
          name: 'invoke_subagent',
          args: {
            Subagents: [{ Role: 'Debugger', TypeName: 'debugger' }]
          }
        }
      ]
    })

    // 2. Tool output in subsequent step
    tracker.processStep({
      step_index: 6,
      type: 'USER_INPUT',
      content: JSON.stringify({
        conversationId: 'sub-abc-123',
        logAbsoluteUri: 'file:///path/to/transcript.jsonl',
        role: 'Debugger'
      })
    })

    const agent = tracker.getAgent('sub-abc-123')
    expect(agent).toBeDefined()
    expect(agent?.label).toBe('Debugger')
    expect(agent?.state).toBe('working')

    tracker.dispose()
  })

  it('tracks subagent lifecycle through child transcript polling', () => {
    const testDir = join(tmpdir(), `orca-subagent-test-${Date.now()}`)
    mkdirSync(testDir, { recursive: true })
    const childTranscript = join(testDir, 'transcript.jsonl')
    writeFileSync(childTranscript, '', 'utf8')

    let mockTime = 5000
    const tracker = new AntigravitySubagentRosterTracker({ now: () => mockTime })

    // Provide step with child transcript file URL
    const fileUrl = pathToFileURL(childTranscript).href
    tracker.processStep({
      step_index: 12,
      type: 'USER_INPUT',
      content: JSON.stringify({
        conversationId: 'sub-worker-1',
        logAbsoluteUri: fileUrl,
        role: 'Worker'
      })
    })

    expect(tracker.getAgent('sub-worker-1')?.tokens).toBeUndefined()

    // Child appends work with tokens
    writeFileSync(
      childTranscript,
      `${JSON.stringify({ step_index: 1, type: 'MODEL', input_tokens: 150, output_tokens: 50 })}\n`,
      { flag: 'a', encoding: 'utf8' }
    )

    tracker.pollChildTranscripts()
    expect(tracker.getAgent('sub-worker-1')?.tokens).toBe(200)
    expect(tracker.getAgent('sub-worker-1')?.state).toBe('working')

    // Child completes
    mockTime = 6000
    writeFileSync(
      childTranscript,
      `${JSON.stringify({ step_index: 2, type: 'MODEL', status: 'DONE', input_tokens: 50, output_tokens: 25 })}\n`,
      { flag: 'a', encoding: 'utf8' }
    )

    tracker.pollChildTranscripts()
    expect(tracker.getAgent('sub-worker-1')?.tokens).toBe(275)
    expect(tracker.getAgent('sub-worker-1')?.state).toBe('completed')
    expect(tracker.getAgent('sub-worker-1')?.settledAt).toBe(6000)

    tracker.dispose()
    try {
      unlinkSync(childTranscript)
    } catch {
      // ignore
    }
  })

  it('handles manage_subagents kill action', () => {
    let mockTime = 3000
    const tracker = new AntigravitySubagentRosterTracker({ now: () => mockTime })

    tracker.processStep({
      step_index: 1,
      type: 'USER_INPUT',
      content: JSON.stringify({ conversationId: 'agent-x', role: 'Worker X' })
    })

    expect(tracker.getAgent('agent-x')?.state).toBe('working')

    mockTime = 4000
    tracker.processStep({
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      tool_calls: [
        {
          name: 'manage_subagents',
          args: {
            Action: 'kill',
            ConversationIds: ['agent-x']
          }
        }
      ]
    })

    expect(tracker.getAgent('agent-x')?.state).toBe('stopped')
    expect(tracker.getAgent('agent-x')?.settledAt).toBe(4000)

    tracker.dispose()
  })

  it('re-activates subagent to working on send_message', () => {
    const tracker = new AntigravitySubagentRosterTracker()

    tracker.processStep({
      step_index: 1,
      type: 'USER_INPUT',
      content: JSON.stringify({ conversationId: 'agent-y', role: 'Worker Y', state: 'idle' })
    })

    expect(tracker.getAgent('agent-y')?.state).toBe('idle')

    tracker.processStep({
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      tool_calls: [
        {
          name: 'send_message',
          args: {
            Recipient: 'agent-y',
            Message: 'Continue with task'
          }
        }
      ]
    })

    expect(tracker.getAgent('agent-y')?.state).toBe('working')

    tracker.dispose()
  })
})
