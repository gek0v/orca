import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  createAntigravitySubagentTranscriptState,
  reconcileAntigravitySubagentTranscript
} from './antigravity-subagent-transcript'
import {
  antigravityRosterToSnapshots,
  type AntigravitySubagentRoster
} from './antigravity-subagent-roster'

describe('antigravity-subagent-transcript', () => {
  it('reconciles subagents from disk descriptor files', () => {
    const testDir = join(tmpdir(), `orca-agy-subagent-test-${Date.now()}`)
    const brainDir = join(testDir, 'brain', 'parent-123')
    const subagentsDir = join(brainDir, '.system_generated', 'subagents')
    const logsDir = join(brainDir, '.system_generated', 'logs')
    mkdirSync(subagentsDir, { recursive: true })
    mkdirSync(logsDir, { recursive: true })

    const transcriptPath = join(logsDir, 'transcript.jsonl')
    writeFileSync(transcriptPath, '')

    writeFileSync(
      join(subagentsDir, 'child-abc.json'),
      JSON.stringify({
        conversationId: 'child-abc',
        subagentDescriptor: {
          typeName: 'web-developer',
          role: 'Web Full-Stack Auditor'
        },
        state: 'SUBAGENT_STATE_ALIVE'
      })
    )

    const state = createAntigravitySubagentTranscriptState()
    const roster: AntigravitySubagentRoster = new Map()

    const changed = reconcileAntigravitySubagentTranscript(state, roster, transcriptPath)
    expect(changed).toBe(true)

    const snapshots = antigravityRosterToSnapshots(roster)
    expect(snapshots).toHaveLength(1)
    expect(snapshots?.[0]?.id).toBe('child-abc')
    expect(snapshots?.[0]?.agentType).toBe('web-developer')
    expect(snapshots?.[0]?.description).toBe('Web Full-Stack Auditor')
    expect(snapshots?.[0]?.state).toBe('working')

    rmSync(testDir, { recursive: true, force: true })
  })

  it('reconciles subagents from transcript invoke_subagent tool calls', () => {
    const testDir = join(tmpdir(), `orca-agy-subagent-test-2-${Date.now()}`)
    const logsDir = join(testDir, 'logs')
    mkdirSync(logsDir, { recursive: true })
    const transcriptPath = join(logsDir, 'transcript.jsonl')

    const step1 = JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      tool_calls: [
        {
          name: 'invoke_subagent',
          args: {
            Subagents: [
              {
                TypeName: 'forge-dev',
                Role: 'Forge Auditor',
                Model: 'inherit'
              }
            ]
          }
        }
      ]
    })
    const step2 = JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      content:
        'Created the following subagents:\n{\n  "conversationId":  "child-forge-1",\n  "logAbsoluteUri":  "uri"\n}'
    })

    writeFileSync(transcriptPath, `${step1}\n${step2}\n`)

    const state = createAntigravitySubagentTranscriptState()
    const roster: AntigravitySubagentRoster = new Map()

    const changed = reconcileAntigravitySubagentTranscript(state, roster, transcriptPath)
    expect(changed).toBe(true)

    const snapshots = antigravityRosterToSnapshots(roster)
    expect(snapshots).toHaveLength(1)
    expect(snapshots?.[0]?.id).toBe('child-forge-1')
    expect(snapshots?.[0]?.agentType).toBe('forge-dev')
    expect(snapshots?.[0]?.description).toBe('Forge Auditor')
    expect(snapshots?.[0]?.state).toBe('working')

    rmSync(testDir, { recursive: true, force: true })
  })

  it('removes subagent from roster when it reports completion message to parent', () => {
    const testDir = join(tmpdir(), `orca-agy-subagent-complete-${Date.now()}`)
    const brainDir = join(testDir, 'brain', 'parent-123')
    const subagentsDir = join(brainDir, '.system_generated', 'subagents')
    const logsDir = join(brainDir, '.system_generated', 'logs')
    mkdirSync(subagentsDir, { recursive: true })
    mkdirSync(logsDir, { recursive: true })
    const transcriptPath = join(logsDir, 'transcript.jsonl')

    writeFileSync(
      join(subagentsDir, 'child-task-1.json'),
      JSON.stringify({
        conversationId: 'child-task-1',
        subagentDescriptor: {
          typeName: 'self',
          role: 'Backend Implementer'
        },
        state: 'SUBAGENT_STATE_ALIVE'
      })
    )

    const step1 = JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      tool_calls: [
        {
          name: 'invoke_subagent',
          args: {
            Subagents: [
              {
                TypeName: 'self',
                Role: 'Backend Implementer',
                Model: 'inherit'
              }
            ]
          }
        }
      ]
    })
    const step2 = JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      content:
        'Created the following subagents:\n{\n  "conversationId":  "child-task-1",\n  "logAbsoluteUri":  "uri"\n}'
    })

    writeFileSync(transcriptPath, `${step1}\n${step2}\n`)

    const state = createAntigravitySubagentTranscriptState()
    const roster: AntigravitySubagentRoster = new Map()

    // 1. Initial reconcile: subagent should be detected as working
    reconcileAntigravitySubagentTranscript(state, roster, transcriptPath)
    expect(antigravityRosterToSnapshots(roster)).toHaveLength(1)
    expect(antigravityRosterToSnapshots(roster)?.[0]?.id).toBe('child-task-1')
    expect(antigravityRosterToSnapshots(roster)?.[0]?.state).toBe('working')

    // 2. Child completes and sends message to parent
    const step3 = JSON.stringify({
      step_index: 3,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      content:
        '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-10-07T07:30:58Z sender=child-task-1 priority=MESSAGE_PRIORITY_HIGH content=Task 1 complete\n</SYSTEM_MESSAGE>'
    })
    writeFileSync(transcriptPath, `${step1}\n${step2}\n${step3}\n`)

    // 3. Reconcile: child should now be settled and REMOVED from roster, not lingering as working/idle
    const changed = reconcileAntigravitySubagentTranscript(state, roster, transcriptPath)
    expect(changed).toBe(true)
    expect(antigravityRosterToSnapshots(roster)).toBeUndefined()

    // 4. Subsequent reconcile should not resurrect child from disk file
    const changedAgain = reconcileAntigravitySubagentTranscript(state, roster, transcriptPath)
    expect(changedAgain).toBe(false)
    expect(antigravityRosterToSnapshots(roster)).toBeUndefined()

    rmSync(testDir, { recursive: true, force: true })
  })

  it('detects completed child subagent directly from child transcript ending with DONE', () => {
    const testDir = join(tmpdir(), `orca-agy-subagent-child-done-${Date.now()}`)
    const parentBrainDir = join(testDir, 'brain', 'parent-done-test')
    const childBrainDir = join(testDir, 'brain', 'child-task-2')
    const subagentsDir = join(parentBrainDir, '.system_generated', 'subagents')
    const parentLogsDir = join(parentBrainDir, '.system_generated', 'logs')
    const childLogsDir = join(childBrainDir, '.system_generated', 'logs')
    mkdirSync(subagentsDir, { recursive: true })
    mkdirSync(parentLogsDir, { recursive: true })
    mkdirSync(childLogsDir, { recursive: true })
    const parentTranscriptPath = join(parentLogsDir, 'transcript.jsonl')
    const childTranscriptPath = join(childLogsDir, 'transcript.jsonl')

    writeFileSync(
      join(subagentsDir, 'child-task-2.json'),
      JSON.stringify({
        conversationId: 'child-task-2',
        subagentDescriptor: {
          typeName: 'self',
          role: 'Backend Rate-Limit Implementer'
        },
        state: 'SUBAGENT_STATE_ALIVE'
      })
    )

    // Child transcript ends with DONE
    writeFileSync(
      childTranscriptPath,
      `${JSON.stringify({
        step_index: 10,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Task complete'
      })}\n`
    )

    writeFileSync(parentTranscriptPath, '')

    const state = createAntigravitySubagentTranscriptState()
    const roster: AntigravitySubagentRoster = new Map()

    const changed = reconcileAntigravitySubagentTranscript(state, roster, parentTranscriptPath)
    expect(changed).toBe(true)
    expect(antigravityRosterToSnapshots(roster)).toBeUndefined()
    expect(state.completedSubagents.has('child-task-2')).toBe(true)

    const changedAgain = reconcileAntigravitySubagentTranscript(state, roster, parentTranscriptPath)
    expect(changedAgain).toBe(false)
    expect(antigravityRosterToSnapshots(roster)).toBeUndefined()

    rmSync(testDir, { recursive: true, force: true })
  })
})
