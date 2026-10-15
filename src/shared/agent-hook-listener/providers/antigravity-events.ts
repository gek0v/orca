import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { readFirstString } from '../interactive-tool'
import type { HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readLastUserPromptFromTranscript } from '../transcript-lines'
import { continueMainAgentStatus, foldAgentLeadStatus } from '../../agent-lead-status-fold'
import {
  antigravityRosterChildWorkLiveness,
  antigravityRosterToSnapshots,
  type AntigravitySubagentRoster
} from '../../antigravity-subagent-roster'
import {
  createAntigravitySubagentTranscriptState,
  reconcileAntigravitySubagentTranscript,
  type AntigravitySubagentTranscriptState
} from '../../antigravity-subagent-transcript'
import { readAntigravityToolCall } from './antigravity-tool-fields'
import { isAntigravityStopStillBusy } from './antigravity-event-rules'

export function getOrCreateAntigravitySubagentRoster(
  state: HookListenerState,
  paneKey: string
): AntigravitySubagentRoster {
  let roster = state.antigravitySubagentRosterByPaneKey.get(paneKey)
  if (!roster) {
    roster = new Map()
    state.antigravitySubagentRosterByPaneKey.set(paneKey, roster)
  }
  return roster
}

export function getOrCreateAntigravitySubagentTranscriptState(
  state: HookListenerState,
  paneKey: string
): AntigravitySubagentTranscriptState {
  let transcriptState = state.antigravitySubagentTranscriptByPaneKey.get(paneKey)
  if (!transcriptState) {
    transcriptState = createAntigravitySubagentTranscriptState()
    state.antigravitySubagentTranscriptByPaneKey.set(paneKey, transcriptState)
  }
  return transcriptState
}

export function hasAntigravityTranscriptSubagents(
  state: HookListenerState,
  paneKey: string
): boolean {
  const roster = state.antigravitySubagentRosterByPaneKey.get(paneKey)
  return Boolean(roster && roster.size > 0)
}

export function isAntigravityFeedbackTool(toolName: string | undefined): boolean {
  return toolName === 'ask_question' || toolName === 'ask_permission'
}

export function normalizeAntigravityEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const transcriptPath = readFirstString(hookPayload, ['transcriptPath', 'transcript_path'])
  if (eventName === 'PreInvocation') {
    state.antigravityCompletedTranscriptByPaneKey.delete(paneKey)
  } else if (
    transcriptPath &&
    eventName !== 'Stop' &&
    state.antigravityCompletedTranscriptByPaneKey.get(paneKey) === transcriptPath
  ) {
    // Why: agy can emit a bookkeeping PostToolUse after Stop; ignore it so a finished row doesn't turn back into a yellow spinner.
    return null
  }

  const toolName = readAntigravityToolCall(hookPayload).toolName
  const stopStillBusy = eventName === 'Stop' && isAntigravityStopStillBusy(hookPayload)
  const stateName =
    eventName === 'PreToolUse' && isAntigravityFeedbackTool(toolName)
      ? 'waiting'
      : eventName === 'Stop'
        ? stopStillBusy
          ? 'working'
          : 'done'
        : eventName === 'PreInvocation' ||
            eventName === 'PostInvocation' ||
            eventName === 'PreToolUse' ||
            eventName === 'PostToolUse'
          ? 'working'
          : null

  if (!stateName) {
    return null
  }

  const resetsTurn = isNewTurnEvent('antigravity', eventName)
  // Why: once the prompt is cached for this pane, avoid rescanning the (potentially large) Antigravity transcript per hook.
  const cachedPrompt = resetsTurn ? undefined : state.lastPromptByPaneKey.get(paneKey)
  const effectivePrompt =
    promptText || cachedPrompt || readLastUserPromptFromTranscript(transcriptPath) || ''
  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('antigravity', eventName, hookPayload),
    { resetOnNewTurn: resetsTurn }
  )

  const effectiveTranscriptPath =
    transcriptPath ?? state.antigravitySubagentTranscriptByPaneKey.get(paneKey)?.parent.filePath

  if (effectiveTranscriptPath) {
    const roster = getOrCreateAntigravitySubagentRoster(state, paneKey)
    const transcriptState = getOrCreateAntigravitySubagentTranscriptState(state, paneKey)
    reconcileAntigravitySubagentTranscript(transcriptState, roster, effectiveTranscriptPath)
  }

  const roster = state.antigravitySubagentRosterByPaneKey.get(paneKey)
  const childWorkLiveness = antigravityRosterChildWorkLiveness(roster)
  const resolution = foldAgentLeadStatus({
    leadState: stateName,
    childWorkLiveness
  })

  // Why: Antigravity can emit Stop with fullyIdle=false between tool steps; only a fully idle Stop without subagents is terminal.
  const hasRunningSubagents = hasAntigravityTranscriptSubagents(state, paneKey)
  if (eventName === 'Stop' && !stopStillBusy && effectiveTranscriptPath) {
    if (!hasRunningSubagents) {
      state.antigravityCompletedTranscriptByPaneKey.set(paneKey, effectiveTranscriptPath)
      state.antigravitySubagentRosterByPaneKey.delete(paneKey)
      state.antigravitySubagentTranscriptByPaneKey.delete(paneKey)
    }
  }

  const previousMainAgent = state.antigravityMainAgentStatusByPaneKey.get(paneKey)
  const mainAgent = continueMainAgentStatus(previousMainAgent, { state: stateName }, Date.now())
  state.antigravityMainAgentStatusByPaneKey.set(paneKey, mainAgent)

  const payload = normalizeAgentStatusPayload({
    state: resolution.stateName,
    ...(resolution.workingMode ? { workingMode: resolution.workingMode } : {}),
    prompt: resolvePrompt(state, paneKey, effectivePrompt, {
      resetOnNewTurn: resetsTurn
    }),
    agentType: 'antigravity',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    subagents: antigravityRosterToSnapshots(state.antigravitySubagentRosterByPaneKey.get(paneKey)),
    mainAgent
  })
  return payload
}
