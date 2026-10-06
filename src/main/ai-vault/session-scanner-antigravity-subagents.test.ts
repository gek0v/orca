import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  countAntigravitySubagents,
  listAntigravitySubagentSessions
} from './session-scanner-antigravity-subagents'

describe('session-scanner-antigravity-subagents', () => {
  it('counts and lists subagents for an Antigravity session', async () => {
    const testDir = join(tmpdir(), `orca-agy-ai-vault-test-${Date.now()}`)
    const parentId = 'parent-session-123'
    const childId = 'child-session-456'

    const brainDir = join(testDir, 'brain')
    const parentSessionDir = join(brainDir, parentId, '.system_generated')
    const parentLogsDir = join(parentSessionDir, 'logs')
    const parentSubagentsDir = join(parentSessionDir, 'subagents')

    const childSessionDir = join(brainDir, childId, '.system_generated')
    const childLogsDir = join(childSessionDir, 'logs')

    mkdirSync(parentLogsDir, { recursive: true })
    mkdirSync(parentSubagentsDir, { recursive: true })
    mkdirSync(childLogsDir, { recursive: true })

    const parentTranscript = join(parentLogsDir, 'transcript.jsonl')
    writeFileSync(parentTranscript, '')

    writeFileSync(
      join(parentSubagentsDir, `${childId}.json`),
      JSON.stringify({
        conversationId: childId,
        subagentDescriptor: {
          typeName: 'web-developer',
          role: 'Web Full-Stack Auditor'
        },
        state: 'SUBAGENT_STATE_ALIVE',
        workspaceUris: ['file:///C:/Users/Geko/test/project']
      })
    )

    const childTranscript = join(childLogsDir, 'transcript.jsonl')
    const childStep1 = JSON.stringify({
      step_index: 0,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      content: 'Starting the web audit...'
    })
    writeFileSync(childTranscript, `${childStep1}\n`)

    const count = await countAntigravitySubagents(parentTranscript)
    expect(count).toBe(1)

    const result = await listAntigravitySubagentSessions({ parentFilePath: parentTranscript })
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]?.sessionId).toBe(childId)
    expect(result.sessions[0]?.title).toBe('Web Full-Stack Auditor')
    expect(result.sessions[0]?.subagent?.parentSessionId).toBe(parentId)
    expect(result.sessions[0]?.subagent?.agentType).toBe('web-developer')
    expect(result.sessions[0]?.subagent?.status).toBe('running')

    rmSync(testDir, { recursive: true, force: true })
  })
})
