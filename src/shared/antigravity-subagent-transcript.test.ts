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

  it('discovers and reconciles nested hierarchical subagents across multiple levels', () => {
    const testDir = join(tmpdir(), `orca-agy-nested-test-${Date.now()}`)
    const rootBrainDir = join(testDir, 'brain', 'root-conv')
    const child1BrainDir = join(testDir, 'brain', 'sentinel-child-1')
    const child2BrainDir = join(testDir, 'brain', 'orchestrator-child-2')

    // Root -> sentinel-child-1
    const rootSubagentsDir = join(rootBrainDir, '.system_generated', 'subagents')
    const rootLogsDir = join(rootBrainDir, '.system_generated', 'logs')
    mkdirSync(rootSubagentsDir, { recursive: true })
    mkdirSync(rootLogsDir, { recursive: true })
    const rootTranscriptPath = join(rootLogsDir, 'transcript.jsonl')
    writeFileSync(rootTranscriptPath, '')

    writeFileSync(
      join(rootSubagentsDir, 'sentinel-child-1.json'),
      JSON.stringify({
        conversationId: 'sentinel-child-1',
        subagentDescriptor: {
          typeName: 'teamwork_preview',
          role: 'Teamwork Orchestrator'
        },
        state: 'SUBAGENT_STATE_ALIVE'
      })
    )

    // sentinel-child-1 -> orchestrator-child-2
    const child1SubagentsDir = join(child1BrainDir, '.system_generated', 'subagents')
    mkdirSync(child1SubagentsDir, { recursive: true })
    writeFileSync(
      join(child1SubagentsDir, 'orchestrator-child-2.json'),
      JSON.stringify({
        conversationId: 'orchestrator-child-2',
        subagentDescriptor: {
          typeName: 'teamwork_preview_orchestrator',
          role: 'Project Orchestrator'
        },
        state: 'SUBAGENT_STATE_ALIVE'
      })
    )

    // orchestrator-child-2 -> worker-child-3
    const child2SubagentsDir = join(child2BrainDir, '.system_generated', 'subagents')
    mkdirSync(child2SubagentsDir, { recursive: true })
    writeFileSync(
      join(child2SubagentsDir, 'worker-child-3.json'),
      JSON.stringify({
        conversationId: 'worker-child-3',
        subagentDescriptor: {
          typeName: 'teamwork_preview_worker',
          role: 'IPC WebSocket Worker'
        },
        state: 'SUBAGENT_STATE_ALIVE'
      })
    )

    const state = createAntigravitySubagentTranscriptState()
    const roster: AntigravitySubagentRoster = new Map()

    const changed = reconcileAntigravitySubagentTranscript(state, roster, rootTranscriptPath)
    expect(changed).toBe(true)

    const snapshots = antigravityRosterToSnapshots(roster)
    expect(snapshots).toHaveLength(3)

    const ids = snapshots?.map((s) => s.id)
    expect(ids).toContain('sentinel-child-1')
    expect(ids).toContain('orchestrator-child-2')
    expect(ids).toContain('worker-child-3')

    const sentinel = snapshots?.find((s) => s.id === 'sentinel-child-1')
    expect(sentinel?.description).toBe('Teamwork Orchestrator')
    expect(sentinel?.agentType).toBe('teamwork_preview')
    expect(sentinel?.state).toBe('working')

    const orchestrator = snapshots?.find((s) => s.id === 'orchestrator-child-2')
    expect(orchestrator?.description).toBe('Project Orchestrator')
    expect(orchestrator?.agentType).toBe('teamwork_preview_orchestrator')
    expect(orchestrator?.state).toBe('working')

    const worker = snapshots?.find((s) => s.id === 'worker-child-3')
    expect(worker?.description).toBe('IPC WebSocket Worker')
    expect(worker?.agentType).toBe('teamwork_preview_worker')
    expect(worker?.state).toBe('working')

    rmSync(testDir, { recursive: true, force: true })
  })

  it('keeps subagent in roster when intermediate status update message is received', () => {
    const testDir = join(tmpdir(), `orca-agy-status-update-${Date.now()}`)
    const brainDir = join(testDir, 'brain', 'parent-sentinel-test')
    const subagentsDir = join(brainDir, '.system_generated', 'subagents')
    const logsDir = join(brainDir, '.system_generated', 'logs')
    mkdirSync(subagentsDir, { recursive: true })
    mkdirSync(logsDir, { recursive: true })
    const transcriptPath = join(logsDir, 'transcript.jsonl')

    writeFileSync(
      join(subagentsDir, 'sentinel-live-1.json'),
      JSON.stringify({
        conversationId: 'sentinel-live-1',
        subagentDescriptor: {
          typeName: 'teamwork_preview',
          role: 'Teamwork Orchestrator'
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
                TypeName: 'teamwork_preview',
                Role: 'Teamwork Orchestrator',
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
        'Created the following subagents:\n{\n  "conversationId":  "sentinel-live-1",\n  "logAbsoluteUri":  "uri"\n}'
    })
    // Intermediate status update message (NOT a completion message)
    const step3 = JSON.stringify({
      step_index: 3,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      content:
        '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-10-12T11:22:25Z sender=sentinel-live-1 priority=MESSAGE_PRIORITY_HIGH content=## Project Sentinel Status Update\n\n- Request Recorded: ok\n- Orchestrator Dispatched: active\n</SYSTEM_MESSAGE>'
    })

    writeFileSync(transcriptPath, `${step1}\n${step2}\n${step3}\n`)

    const state = createAntigravitySubagentTranscriptState()
    const roster: AntigravitySubagentRoster = new Map()

    const changed = reconcileAntigravitySubagentTranscript(state, roster, transcriptPath)
    expect(changed).toBe(true)

    const snapshots = antigravityRosterToSnapshots(roster)
    expect(snapshots).toHaveLength(1)
    expect(snapshots?.[0]?.id).toBe('sentinel-live-1')
    expect(snapshots?.[0]?.state).toBe('working')

    rmSync(testDir, { recursive: true, force: true })
  })

  it('keeps active subagent with intermediate steps in roster', () => {
    const testDir = join(tmpdir(), `orca-agy-active-steps-${Date.now()}`)
    const parentBrainDir = join(testDir, 'brain', 'parent-orch')
    const childBrainDir = join(testDir, 'brain', 'orch-live-2')
    const subagentsDir = join(parentBrainDir, '.system_generated', 'subagents')
    const parentLogsDir = join(parentBrainDir, '.system_generated', 'logs')
    const childLogsDir = join(childBrainDir, '.system_generated', 'logs')
    mkdirSync(subagentsDir, { recursive: true })
    mkdirSync(parentLogsDir, { recursive: true })
    mkdirSync(childLogsDir, { recursive: true })
    const parentTranscriptPath = join(parentLogsDir, 'transcript.jsonl')
    const childTranscriptPath = join(childLogsDir, 'transcript.jsonl')

    writeFileSync(
      join(subagentsDir, 'orch-live-2.json'),
      JSON.stringify({
        conversationId: 'orch-live-2',
        subagentDescriptor: {
          typeName: 'teamwork_preview_orchestrator',
          role: 'Project Orchestrator'
        },
        state: 'SUBAGENT_STATE_ALIVE'
      })
    )

    // Child has step with DONE status, but it's an intermediate update waiting/standing by for workers
    writeFileSync(
      childTranscriptPath,
      `${JSON.stringify({
        step_index: 20,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Worker 3 has completed. Standing by for Worker 1 and Worker 2.'
      })}\n`
    )
    writeFileSync(parentTranscriptPath, '')

    const state = createAntigravitySubagentTranscriptState()
    const roster: AntigravitySubagentRoster = new Map()

    const changed = reconcileAntigravitySubagentTranscript(state, roster, parentTranscriptPath)
    expect(changed).toBe(true)

    const snapshots = antigravityRosterToSnapshots(roster)
    expect(snapshots).toHaveLength(1)
    expect(snapshots?.[0]?.id).toBe('orch-live-2')
    expect(snapshots?.[0]?.agentType).toBe('teamwork_preview_orchestrator')
    expect(snapshots?.[0]?.description).toBe('Project Orchestrator')
    expect(snapshots?.[0]?.state).toBe('working')

    rmSync(testDir, { recursive: true, force: true })
  })

  it('retains active subagents reporting idle in manage_subagents as idle state without eviction', () => {
    const testDir = join(tmpdir(), `orca-agy-idle-subagent-${Date.now()}`)
    const brainDir = join(testDir, 'brain', 'parent-idle-test')
    const subagentsDir = join(brainDir, '.system_generated', 'subagents')
    const logsDir = join(brainDir, '.system_generated', 'logs')
    mkdirSync(subagentsDir, { recursive: true })
    mkdirSync(logsDir, { recursive: true })
    const transcriptPath = join(logsDir, 'transcript.jsonl')

    writeFileSync(
      join(subagentsDir, 'forge-auditor.json'),
      JSON.stringify({
        conversationId: 'forge-auditor',
        subagentDescriptor: {
          typeName: 'forge-mod-developer',
          role: 'Forge Mod Auditor'
        },
        state: 'SUBAGENT_STATE_ALIVE'
      })
    )

    // Transcript contains manage_subagents result with state: "idle"
    const step1 = JSON.stringify({
      step_index: 43,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      content:
        'You have 1 active subagent(s):\n[{"role":"Forge Mod Auditor","type":"forge-mod-developer","conversationId":"forge-auditor","state":"idle"}]'
    })
    writeFileSync(transcriptPath, `${step1}\n`)

    const state = createAntigravitySubagentTranscriptState()
    const roster: AntigravitySubagentRoster = new Map()

    const changed = reconcileAntigravitySubagentTranscript(state, roster, transcriptPath)
    expect(changed).toBe(true)

    // The subagent must stay in the roster with state: 'idle', not evicted or treated as completed
    const snapshots = antigravityRosterToSnapshots(roster)
    expect(snapshots).toHaveLength(1)
    expect(snapshots?.[0]?.id).toBe('forge-auditor')
    expect(snapshots?.[0]?.state).toBe('idle')
    expect(state.completedSubagents.has('forge-auditor')).toBe(false)

    rmSync(testDir, { recursive: true, force: true })
  })

  it('removes subagent when completion message is sent in Spanish', () => {
    const testDir = join(tmpdir(), `orca-agy-spanish-complete-${Date.now()}`)
    const brainDir = join(testDir, 'brain', 'parent-es')
    const subagentsDir = join(brainDir, '.system_generated', 'subagents')
    const logsDir = join(brainDir, '.system_generated', 'logs')
    mkdirSync(subagentsDir, { recursive: true })
    mkdirSync(logsDir, { recursive: true })
    const transcriptPath = join(logsDir, 'transcript.jsonl')

    writeFileSync(
      join(subagentsDir, 'worker-es-1.json'),
      JSON.stringify({
        conversationId: 'worker-es-1',
        subagentDescriptor: { typeName: 'self', role: 'Auditor de Código' },
        state: 'SUBAGENT_STATE_ALIVE'
      })
    )

    const step1 = JSON.stringify({
      step_index: 1,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      content:
        '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-10-12T10:00:00Z sender=worker-es-1 priority=MESSAGE_PRIORITY_HIGH content=Revisión completada al 100%. Todos los tests pasan.\n</SYSTEM_MESSAGE>'
    })
    writeFileSync(transcriptPath, `${step1}\n`)

    const state = createAntigravitySubagentTranscriptState()
    const roster: AntigravitySubagentRoster = new Map()

    const changed = reconcileAntigravitySubagentTranscript(state, roster, transcriptPath)
    expect(changed).toBe(true)
    expect(antigravityRosterToSnapshots(roster)).toBeUndefined()
    expect(state.completedSubagents.has('worker-es-1')).toBe(true)

    rmSync(testDir, { recursive: true, force: true })
  })

  it('recognizes SUBAGENT_STATE_KILLED from disk descriptor as completed', () => {
    const testDir = join(tmpdir(), `orca-agy-killed-subagent-${Date.now()}`)
    const brainDir = join(testDir, 'brain', 'parent-killed')
    const subagentsDir = join(brainDir, '.system_generated', 'subagents')
    const logsDir = join(brainDir, '.system_generated', 'logs')
    mkdirSync(subagentsDir, { recursive: true })
    mkdirSync(logsDir, { recursive: true })
    const transcriptPath = join(logsDir, 'transcript.jsonl')
    writeFileSync(transcriptPath, '')

    writeFileSync(
      join(subagentsDir, 'killed-worker.json'),
      JSON.stringify({
        conversationId: 'killed-worker',
        subagentDescriptor: { typeName: 'worker', role: 'Killed Worker' },
        state: 'SUBAGENT_STATE_KILLED'
      })
    )

    const state = createAntigravitySubagentTranscriptState()
    const roster: AntigravitySubagentRoster = new Map()

    const changed = reconcileAntigravitySubagentTranscript(state, roster, transcriptPath)
    expect(changed).toBe(true)
    expect(antigravityRosterToSnapshots(roster)).toBeUndefined()
    expect(state.completedSubagents.has('killed-worker')).toBe(true)

    const changedAgain = reconcileAntigravitySubagentTranscript(state, roster, transcriptPath)
    expect(changedAgain).toBe(false)
    expect(antigravityRosterToSnapshots(roster)).toBeUndefined()

    rmSync(testDir, { recursive: true, force: true })
  })
})
