import { describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHookListenerState } from '../listener-state'
import { normalizeAntigravityEvent } from './antigravity-events'

describe('antigravity-events', () => {
  it('normalizes antigravity PreToolUse and attaches reconciled subagents', () => {
    const testDir = join(tmpdir(), `orca-agy-events-test-${Date.now()}`)
    const brainDir = join(testDir, 'brain', 'parent-123')
    const subagentsDir = join(brainDir, '.system_generated', 'subagents')
    const logsDir = join(brainDir, '.system_generated', 'logs')
    mkdirSync(subagentsDir, { recursive: true })
    mkdirSync(logsDir, { recursive: true })

    const transcriptPath = join(logsDir, 'transcript.jsonl')
    writeFileSync(transcriptPath, '')

    writeFileSync(
      join(subagentsDir, 'subagent-xyz.json'),
      JSON.stringify({
        conversationId: 'subagent-xyz',
        subagentDescriptor: {
          typeName: 'web-developer',
          role: 'Web Full-Stack Auditor'
        },
        state: 'SUBAGENT_STATE_ALIVE'
      })
    )

    const state = createHookListenerState()
    const payload = normalizeAntigravityEvent(
      state,
      'PreToolUse',
      'Audit web',
      'pane-1',
      {
        transcriptPath,
        tool_call: { name: 'manage_subagents', args: { Action: 'list' } }
      }
    )

    expect(payload).not.toBeNull()
    expect(payload?.state).toBe('working')
    expect(payload?.agentType).toBe('antigravity')
    expect(payload?.subagents).toHaveLength(1)
    expect(payload?.subagents?.[0]?.id).toBe('subagent-xyz')
    expect(payload?.subagents?.[0]?.agentType).toBe('web-developer')
    expect(payload?.subagents?.[0]?.description).toBe('Web Full-Stack Auditor')
    expect(payload?.subagents?.[0]?.state).toBe('working')

    rmSync(testDir, { recursive: true, force: true })
  })

  it('handles feedback tools as waiting', () => {
    const state = createHookListenerState()
    const payload = normalizeAntigravityEvent(
      state,
      'PreToolUse',
      'Ask question',
      'pane-1',
      {
        toolCall: { name: 'ask_question', args: { questions: ['Proceed?'] } }
      }
    )
    expect(payload?.state).toBe('waiting')
  })
})
