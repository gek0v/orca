import { describe, expect, it } from 'vitest'
import {
  antigravityRosterChildWorkLiveness,
  antigravityRosterToSnapshots,
  finishAntigravitySubagent,
  seedAntigravitySubagentRoster,
  setAntigravitySubagentModel,
  upsertAntigravitySubagent,
  type AntigravitySubagentRoster
} from './antigravity-subagent-roster'

describe('antigravity-subagent-roster', () => {
  it('upserts and converts to snapshots', () => {
    const roster: AntigravitySubagentRoster = new Map()
    upsertAntigravitySubagent(
      roster,
      'agent-1',
      { agentType: 'web-developer', description: 'Web Auditor', state: 'working' },
      1000
    )
    upsertAntigravitySubagent(
      roster,
      'agent-2',
      { agentType: 'forge-mod', description: 'Mod Auditor', state: 'waiting' },
      2000
    )

    const snapshots = antigravityRosterToSnapshots(roster)
    expect(snapshots).toHaveLength(2)
    expect(snapshots?.[0]).toEqual({
      id: 'agent-1',
      agentType: 'web-developer',
      description: 'Web Auditor',
      model: undefined,
      state: 'working',
      startedAt: 1000
    })
    expect(snapshots?.[1]?.state).toBe('waiting')

    const liveness = antigravityRosterChildWorkLiveness(roster)
    expect(liveness).toBe('waiting')
  })

  it('finishes and sets model', () => {
    const roster: AntigravitySubagentRoster = new Map()
    upsertAntigravitySubagent(roster, 'agent-1', { state: 'working' }, 1000)
    setAntigravitySubagentModel(roster, 'agent-1', 'gemini-2.5-pro')
    expect(roster.get('agent-1')?.model).toBe('gemini-2.5-pro')

    finishAntigravitySubagent(roster, 'agent-1')
    expect(roster.has('agent-1')).toBe(false)
    expect(antigravityRosterToSnapshots(roster)).toBeUndefined()
  })

  it('seeds roster from snapshots', () => {
    const roster: AntigravitySubagentRoster = new Map()
    seedAntigravitySubagentRoster(roster, [
      { id: 'agent-1', state: 'working', startedAt: 1000, agentType: 'expert' }
    ])
    expect(roster.get('agent-1')?.agentType).toBe('expert')
  })
})
