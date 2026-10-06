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
})
