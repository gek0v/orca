import type {
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalRenderItem,
  AgentJournalToolCallItem,
  AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import {
  boundPayload,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS,
  type JournalPayloadLimits
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import type { AntigravityTranscriptStep } from './antigravity-transcript-tailer'

export type AntigravityJournalBridgeOptions = {
  sessionId: string
  payloadLimits?: JournalPayloadLimits
  now?: () => number
}

export class AntigravityJournalBridge {
  private readonly sessionId: string
  private readonly payloadLimits: JournalPayloadLimits
  private readonly now: () => number
  private currentSequence = 0
  private currentTurnId: string | null = null

  constructor(options: AntigravityJournalBridgeOptions) {
    this.sessionId = options.sessionId
    this.payloadLimits = options.payloadLimits ?? DEFAULT_JOURNAL_PAYLOAD_LIMITS
    this.now = options.now ?? (() => Date.now())
  }

  public reset(): void {
    this.currentSequence = 0
    this.currentTurnId = null
  }

  public translateStep(step: AntigravityTranscriptStep): AgentJournalRenderItem[] {
    const timestamp = step.created_at ? Date.parse(step.created_at) || this.now() : this.now()
    const items: AgentJournalRenderItem[] = []
    let subIndex = 0

    // Determine turn scope
    if (step.type === 'USER_INPUT' && step.source === 'USER_EXPLICIT') {
      this.currentTurnId = `turn-${this.sessionId}-${step.step_index}`
    }

    const turnScope: AgentJournalTurnScope = this.currentTurnId
      ? { kind: 'turn', turnItemId: this.currentTurnId }
      : { kind: 'thread' }

    // 1. Thinking block (reasoning)
    if (step.thinking && step.thinking.trim().length > 0) {
      const thinkingBody: AgentJournalMessageItem = {
        kind: 'message',
        role: 'reasoning',
        blocks: [{ type: 'text', text: step.thinking }]
      }
      items.push(this.createItem(thinkingBody, step.step_index, subIndex++, timestamp, turnScope))
    }

    // 2. User input or tool results
    if (step.type === 'USER_INPUT' && step.content) {
      const role = step.source === 'USER_EXPLICIT' ? 'user' : 'tool'
      const messageBody: AgentJournalMessageItem = {
        kind: 'message',
        role,
        blocks: [{ type: 'text', text: step.content }]
      }
      items.push(this.createItem(messageBody, step.step_index, subIndex++, timestamp, turnScope))
    }

    // 3. Assistant text response
    if (step.type === 'PLANNER_RESPONSE' && step.content && step.content.trim().length > 0) {
      const assistantBody: AgentJournalMessageItem = {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: step.content }]
      }
      items.push(this.createItem(assistantBody, step.step_index, subIndex++, timestamp, turnScope))
    }

    // 4. Tool calls
    if (step.tool_calls && step.tool_calls.length > 0) {
      for (const call of step.tool_calls) {
        const toolCallBody: AgentJournalToolCallItem = {
          kind: 'tool-call',
          name: call.name,
          input: call.args,
          callId: `call-${step.step_index}-${subIndex}`,
          state: step.status === 'ERROR' ? 'failed' : 'completed',
          output: boundPayload(JSON.stringify(call.args), this.payloadLimits)
        }
        items.push(this.createItem(toolCallBody, step.step_index, subIndex++, timestamp, turnScope))
      }
    }

    return items
  }

  private createItem(
    body: AgentJournalItemBody,
    stepIndex: number,
    subIndex: number,
    timestamp: number,
    turnScope: AgentJournalTurnScope
  ): AgentJournalRenderItem {
    this.currentSequence++
    return {
      itemId: `agy-${this.sessionId}-${stepIndex}-${subIndex}`,
      revision: 1,
      body,
      sequence: this.currentSequence,
      sequenceIndex: subIndex,
      observedAt: timestamp,
      turnScope
    }
  }
}
