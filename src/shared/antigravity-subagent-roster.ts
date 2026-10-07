import {
  AGENT_MODEL_MAX_LENGTH,
  AGENT_STATUS_MAX_SUBAGENTS,
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_TYPE_MAX_LENGTH,
  type AgentSubagentSnapshot
} from './agent-status-types'
import { normalizeOptionalField } from './agent-status-field-normalization'
import {
  agentChildWorkLiveness,
  type AgentChildWorkLiveness
} from './agent-status-child-work-liveness'

const ANTIGRAVITY_SUBAGENT_ID_MAX_LENGTH = 64

export type TrackedAntigravitySubagent = {
  agentType?: string
  description?: string
  model?: string
  state: 'working' | 'waiting' | 'idle'
  startedAt: number
}

export type AntigravitySubagentRoster = Map<string, TrackedAntigravitySubagent>

export function upsertAntigravitySubagent(
  roster: AntigravitySubagentRoster,
  id: string,
  fields: {
    agentType?: string
    description?: string
    model?: string
    state: 'working' | 'waiting' | 'idle'
  },
  now: number
): void {
  const normalizedId = id.trim()
  if (normalizedId.length === 0 || normalizedId.length > ANTIGRAVITY_SUBAGENT_ID_MAX_LENGTH) {
    return
  }
  const agentType = normalizeOptionalField(fields.agentType, AGENT_TYPE_MAX_LENGTH)
  const description = normalizeOptionalField(fields.description, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH)
  const model = normalizeOptionalField(fields.model, AGENT_MODEL_MAX_LENGTH)
  const existing = roster.get(normalizedId)
  if (existing) {
    existing.agentType = agentType ?? existing.agentType
    existing.description = description ?? existing.description
    existing.model = model ?? existing.model
    existing.state = fields.state
    return
  }
  if (roster.size >= AGENT_STATUS_MAX_SUBAGENTS) {
    return
  }
  roster.set(normalizedId, {
    agentType,
    description,
    model,
    state: fields.state,
    startedAt: now
  })
}

export function finishAntigravitySubagent(roster: AntigravitySubagentRoster, id: string): void {
  roster.delete(id.trim())
}

export function setAntigravitySubagentModel(
  roster: AntigravitySubagentRoster,
  id: string,
  model: string | undefined
): void {
  const normalizedModel = normalizeOptionalField(model, AGENT_MODEL_MAX_LENGTH)
  if (!normalizedModel) {
    return
  }
  const existing = roster.get(id.trim())
  if (!existing) {
    return
  }
  existing.model = normalizedModel
}

export function seedAntigravitySubagentRoster(
  roster: AntigravitySubagentRoster,
  snapshots: readonly AgentSubagentSnapshot[]
): void {
  for (const snapshot of snapshots) {
    if (snapshot.state !== 'working' && snapshot.state !== 'waiting' && snapshot.state !== 'idle') {
      continue
    }
    upsertAntigravitySubagent(
      roster,
      snapshot.id,
      {
        agentType: snapshot.agentType,
        description: snapshot.description,
        model: snapshot.model,
        state: snapshot.state
      },
      snapshot.startedAt
    )
  }
}

export function antigravityRosterToSnapshots(
  roster: AntigravitySubagentRoster | undefined
): AgentSubagentSnapshot[] | undefined {
  if (!roster || roster.size === 0) {
    return undefined
  }
  const snapshots = Array.from(roster, ([id, tracked]) => ({
    id,
    agentType: tracked.agentType,
    description: tracked.description,
    model: tracked.model,
    state: tracked.state,
    startedAt: tracked.startedAt
  }))
  snapshots.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
  return snapshots
}

export function antigravityRosterChildWorkLiveness(
  roster: AntigravitySubagentRoster | undefined
): AgentChildWorkLiveness {
  return agentChildWorkLiveness(
    roster
      ? Array.from(roster.values(), (tracked) => ({
          kind: 'agent' as const,
          state: tracked.state === 'idle' ? 'waiting' : tracked.state
        }))
      : undefined
  )
}
