import {
  antigravityRosterChildWorkLiveness,
  antigravityRosterToSnapshots
} from '../../antigravity-subagent-roster'
import { reconcileAntigravitySubagentTranscript } from '../../antigravity-subagent-transcript'
import { foldAgentLeadStatus } from '../../agent-lead-status-fold'
import type { AgentHookEventPayload } from '../listener-event'
import type { HookListenerState } from '../listener-state'

/** Polling reads subagent updates from Antigravity transcript and disk state. */
export function pollAntigravityTranscriptStatus<T extends AgentHookEventPayload>(
  state: HookListenerState,
  original: T
): T | undefined {
  const transcript = state.antigravitySubagentTranscriptByPaneKey.get(original.paneKey)
  if (!transcript?.parent.filePath) {
    return undefined
  }
  const roster = state.antigravitySubagentRosterByPaneKey.get(original.paneKey)
  if (!roster) {
    return undefined
  }
  const changed = reconcileAntigravitySubagentTranscript(
    transcript,
    roster,
    transcript.parent.filePath
  )
  if (!changed) {
    return original
  }
  const subagents = antigravityRosterToSnapshots(roster)
  const leadState =
    original.payload.mainAgent?.state ?? (original.payload.state === 'done' ? 'done' : 'working')
  const resolution = foldAgentLeadStatus({
    leadState,
    childWorkLiveness: antigravityRosterChildWorkLiveness(roster)
  })
  if (roster.size === 0 && resolution.stateName === 'done') {
    state.antigravityCompletedTranscriptByPaneKey.set(original.paneKey, transcript.parent.filePath)
    state.antigravitySubagentRosterByPaneKey.delete(original.paneKey)
    state.antigravitySubagentTranscriptByPaneKey.delete(original.paneKey)
  }
  return {
    ...original,
    payload: {
      ...original.payload,
      state: resolution.stateName,
      ...(resolution.workingMode ? { workingMode: resolution.workingMode } : {}),
      mainAgent: {
        state: leadState,
        stateStartedAt: original.payload.mainAgent?.stateStartedAt ?? Date.now()
      },
      subagents
    }
  }
}
