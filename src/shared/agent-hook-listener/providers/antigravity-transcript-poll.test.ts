import { describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHookListenerState } from '../listener-state'
import { normalizeAntigravityEvent } from './antigravity-events'
import { pollAntigravityTranscriptStatus } from './antigravity-transcript-poll'
import { transcriptPollUpdate } from '../transcript-poll-policy'
import type { AgentHookEventPayload } from '../listener-event'

describe('antigravity-transcript-poll', () => {
  it('updates payload to done and sets completed transcript when subagent finishes', () => {
    const testDir = join(tmpdir(), `orca-agy-poll-test-${Date.now()}`)
    const parentBrainDir = join(testDir, 'brain', 'parent-poll')
    const childBrainDir = join(testDir, 'brain', 'child-worker-1')
    const subagentsDir = join(parentBrainDir, '.system_generated', 'subagents')
    const parentLogsDir = join(parentBrainDir, '.system_generated', 'logs')
    const childLogsDir = join(childBrainDir, '.system_generated', 'logs')
    mkdirSync(subagentsDir, { recursive: true })
    mkdirSync(parentLogsDir, { recursive: true })
    mkdirSync(childLogsDir, { recursive: true })

    const parentTranscriptPath = join(parentLogsDir, 'transcript.jsonl')
    const childTranscriptPath = join(childLogsDir, 'transcript.jsonl')
    writeFileSync(parentTranscriptPath, '')
    writeFileSync(childTranscriptPath, '')

    writeFileSync(
      join(subagentsDir, 'child-worker-1.json'),
      JSON.stringify({
        conversationId: 'child-worker-1',
        subagentDescriptor: { typeName: 'worker', role: 'Worker' },
        state: 'SUBAGENT_STATE_ALIVE'
      })
    )

    const state = createHookListenerState()
    const initialPayload = normalizeAntigravityEvent(
      state,
      'Stop',
      'Deploy subagent',
      'pane-poll',
      { transcriptPath: parentTranscriptPath }
    )
    expect(initialPayload).not.toBeNull()
    expect(initialPayload?.state).toBe('working')
    expect(initialPayload?.subagents).toHaveLength(1)

    const originalEvent: AgentHookEventPayload = {
      paneKey: 'pane-poll',
      source: 'antigravity',
      connectionId: null,
      payload: initialPayload!
    }

    // 1. First poll with active child returns unchanged or working state
    const polled1 = pollAntigravityTranscriptStatus(state, originalEvent)
    expect(polled1?.payload.state).toBe('working')
    expect(polled1?.payload.subagents).toHaveLength(1)
    expect(state.antigravityCompletedTranscriptByPaneKey.has('pane-poll')).toBe(false)

    // 2. Child finishes and outputs final planner response with status DONE
    writeFileSync(
      childTranscriptPath,
      `${JSON.stringify({
        step_index: 10,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Task completed successfully'
      })}\n`
    )

    // 3. Second poll picks up the finished subagent: state transitions to done
    const polled2 = pollAntigravityTranscriptStatus(state, polled1!)
    expect(polled2).toBeDefined()
    expect(polled2?.payload.state).toBe('done')
    expect(polled2?.payload.subagents).toBeUndefined()
    expect(state.antigravityCompletedTranscriptByPaneKey.get('pane-poll')).toBe(
      parentTranscriptPath
    )

    // 4. transcriptPollUpdate detects state change and produces update
    const update = transcriptPollUpdate('antigravity', originalEvent, polled2!)
    expect(update).toBeDefined()
    expect(update?.payload.state).toBe('done')

    rmSync(testDir, { recursive: true, force: true })
  })
})
