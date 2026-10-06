import { antigravityRosterToSnapshots } from '../../antigravity-subagent-roster'
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
  const changed = reconcileAntigravitySubagentTranscript(transcript, roster, transcript.parent.filePath)
  if (!changed) {
    return original
  }
  const subagents = antigravityRosterToSnapshots(roster)
  return {
    ...original,
    payload: {
      ...original.payload,
      subagents
    }
  }
}
