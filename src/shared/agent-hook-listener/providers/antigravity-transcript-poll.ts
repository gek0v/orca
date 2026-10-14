import {
  antigravityRosterChildWorkLiveness,
  antigravityRosterToSnapshots
} from '../../antigravity-subagent-roster'
import { foldAgentLeadStatus } from '../../agent-lead-status-fold'
import { reconcileAntigravitySubagentTranscript } from '../../antigravity-subagent-transcript'
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
  const liveness = antigravityRosterChildWorkLiveness(roster)
  const leadState = original.payload.mainAgent?.state ?? original.payload.state
  const resolution = foldAgentLeadStatus({
    leadState,
    childWorkLiveness: liveness
  })
  if (roster.size === 0 && resolution.stateName === 'done') {
    state.antigravityCompletedTranscriptByPaneKey.set(original.paneKey, transcript.parent.filePath)
  }
  return {
    ...original,
    payload: {
      ...original.payload,
      state: resolution.stateName,
      ...(resolution.workingMode ? { workingMode: resolution.workingMode } : {}),
      subagents
    }
  }
}
