import { fileURLToPath } from 'node:url'
import type {
  NativeChatSubagentEntry,
  NativeChatSubagentGroupBlock,
  NativeChatSubagentState
} from '../../shared/native-chat-types'
import {
  AntigravityTranscriptTailer,
  type AntigravityTranscriptStep
} from './antigravity-transcript-tailer'

export type AntigravitySubagentRosterListener = (group: NativeChatSubagentGroupBlock) => void

type TrackedSubagent = {
  id: string
  label: string
  role: string
  typeName: string
  groupId: string
  state: NativeChatSubagentState
  tokens: number
  startedAt?: number
  settledAt?: number
  transcriptPath?: string
  childTailer?: AntigravityTranscriptTailer
}

export type AntigravitySubagentRosterTrackerOptions = {
  now?: () => number
}

function mapRawStateToSubagentState(rawState: string): NativeChatSubagentState {
  switch (rawState.toLowerCase()) {
    case 'running':
    case 'waiting_for_dependents':
    case 'canceling':
      return 'working'
    case 'idle':
    case 'waiting_for_input':
    case 'waiting_for_message':
      return 'idle'
    case 'done':
    case 'completed':
      return 'completed'
    case 'errored':
    case 'failed':
      return 'failed'
    case 'killed':
    case 'stopped':
      return 'stopped'
    default:
      return 'working'
  }
}

function parseTranscriptUri(uri: string): string {
  if (uri.startsWith('file://')) {
    try {
      return fileURLToPath(uri)
    } catch {
      return uri.replace(/^file:\/\/\/?/, '')
    }
  }
  return uri
}

export class AntigravitySubagentRosterTracker {
  private readonly now: () => number
  private readonly agents = new Map<string, TrackedSubagent>()
  private readonly listeners = new Set<AntigravitySubagentRosterListener>()
  private isDisposed = false

  constructor(options?: AntigravitySubagentRosterTrackerOptions) {
    this.now = options?.now ?? (() => Date.now())
  }

  public onRosterUpdated(listener: AntigravitySubagentRosterListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  public getGroups(): NativeChatSubagentGroupBlock[] {
    const groupMap = new Map<string, NativeChatSubagentEntry[]>()
    for (const agent of this.agents.values()) {
      const entry: NativeChatSubagentEntry = {
        id: agent.id,
        label: agent.label,
        state: agent.state,
        tokens: agent.tokens > 0 ? agent.tokens : undefined,
        startedAt: agent.startedAt,
        settledAt: agent.settledAt
      }
      const existing = groupMap.get(agent.groupId)
      if (existing) {
        existing.push(entry)
      } else {
        groupMap.set(agent.groupId, [entry])
      }
    }

    return Array.from(groupMap.entries()).map(([groupId, agents]) => ({
      type: 'subagent-group',
      groupId,
      agents
    }))
  }

  public getAgent(id: string): NativeChatSubagentEntry | undefined {
    const agent = this.agents.get(id)
    if (!agent) {
      return undefined
    }
    return {
      id: agent.id,
      label: agent.label,
      state: agent.state,
      tokens: agent.tokens > 0 ? agent.tokens : undefined,
      startedAt: agent.startedAt,
      settledAt: agent.settledAt
    }
  }

  public processStep(step: AntigravityTranscriptStep, fallbackGroupId?: string): void {
    if (this.isDisposed) {
      return
    }

    const currentGroupId = fallbackGroupId ?? `turn-${step.step_index}`

    // 1. Inspect tool calls for invoke_subagent, manage_subagents, send_message
    if (step.tool_calls) {
      for (const call of step.tool_calls) {
        if (call.name === 'invoke_subagent' && call.args) {
          const rawSubagents = Array.isArray(call.args.Subagents) ? call.args.Subagents : []
          for (let i = 0; i < rawSubagents.length; i++) {
            const spec = rawSubagents[i]
            const role = typeof spec === 'object' && spec !== null && 'Role' in spec && typeof spec.Role === 'string'
              ? spec.Role
              : 'Subagent'
            const typeName = typeof spec === 'object' && spec !== null && 'TypeName' in spec && typeof spec.TypeName === 'string'
              ? spec.TypeName
              : 'subagent'
            const placeholderId = `pending-${step.step_index}-${i}`
            if (!this.agents.has(placeholderId)) {
              this.agents.set(placeholderId, {
                id: placeholderId,
                label: role,
                role,
                typeName,
                groupId: currentGroupId,
                state: 'working',
                tokens: 0,
                startedAt: this.now()
              })
              this.notifyGroup(currentGroupId)
            }
          }
        } else if (call.name === 'manage_subagents' && call.args) {
          if (call.args.Action === 'kill') {
            const ids = Array.isArray(call.args.ConversationIds)
              ? call.args.ConversationIds.filter((id): id is string => typeof id === 'string')
              : []
            for (const id of ids) {
              const agent = this.agents.get(id)
              if (agent && agent.state !== 'stopped') {
                agent.state = 'stopped'
                agent.settledAt = this.now()
                this.notifyGroup(agent.groupId)
              }
            }
          }
        } else if (call.name === 'send_message' && call.args) {
          const recipient = typeof call.args.Recipient === 'string' ? call.args.Recipient : ''
          const agent = this.agents.get(recipient)
          if (agent && agent.state !== 'working') {
            agent.state = 'working'
            this.notifyGroup(agent.groupId)
          }
        }
      }
    }

    // 2. Inspect step content for spawn results or subagent status reports
    if (step.content) {
      this.extractSubagentDetailsFromContent(step.content, currentGroupId)
    }
  }

  public pollChildTranscripts(): void {
    if (this.isDisposed) {
      return
    }

    for (const agent of this.agents.values()) {
      if (!agent.childTailer) {
        continue
      }

      const newSteps = agent.childTailer.pollNewSteps()
      if (newSteps.length === 0) {
        continue
      }

      let tokensAdded = 0
      let latestStepDone = false

      for (const childStep of newSteps) {
        if (childStep.input_tokens || childStep.output_tokens) {
          tokensAdded += (childStep.input_tokens ?? 0) + (childStep.output_tokens ?? 0)
        }
        if (childStep.status === 'DONE' || childStep.status === 'ERROR') {
          latestStepDone = childStep.status === 'DONE'
        }
      }

      let changed = false
      if (tokensAdded > 0) {
        agent.tokens += tokensAdded
        changed = true
      }

      if (latestStepDone && agent.state === 'working') {
        agent.state = 'completed'
        agent.settledAt = this.now()
        changed = true
      }

      if (changed) {
        this.notifyGroup(agent.groupId)
      }
    }
  }

  public dispose(): void {
    this.isDisposed = true
    for (const agent of this.agents.values()) {
      if (agent.childTailer) {
        agent.childTailer.close()
      }
    }
    this.agents.clear()
    this.listeners.clear()
  }

  private extractSubagentDetailsFromContent(content: string, currentGroupId: string): void {
    // Check for invoke_subagent return structure (contains conversationId, logAbsoluteUri)
    const conversationIdMatches = content.match(/"conversationId":\s*"([^"]+)"/g)
    if (conversationIdMatches) {
      // Find objects containing conversationId, logAbsoluteUri, role
      const jsonRegex = /\{[^{}]*"conversationId":\s*"([^"]+)"[^{}]*\}/g
      let match: RegExpExecArray | null = null
      while ((match = jsonRegex.exec(content)) !== null) {
        const snippet = match[0]
        const idMatch = snippet.match(/"conversationId":\s*"([^"]+)"/)
        if (!idMatch) {
          continue
        }
        const conversationId = idMatch[1]
        const logUriMatch = snippet.match(/"(?:logAbsoluteUri|transcript)":\s*"([^"]+)"/)
        const roleMatch = snippet.match(/"role":\s*"([^"]+)"/)
        const stateMatch = snippet.match(/"state":\s*"([^"]+)"/)

        this.bindSubagent({
          conversationId,
          role: roleMatch ? roleMatch[1] : undefined,
          transcriptUri: logUriMatch ? logUriMatch[1] : undefined,
          rawState: stateMatch ? stateMatch[1] : undefined,
          groupId: currentGroupId
        })
      }
    }
  }

  private bindSubagent(data: {
    conversationId: string
    role?: string
    transcriptUri?: string
    rawState?: string
    groupId: string
  }): void {
    let existing = this.agents.get(data.conversationId)

    if (!existing) {
      // Check if there is an unattached placeholder
      for (const [placeholderId, pending] of this.agents.entries()) {
        if (placeholderId.startsWith('pending-')) {
          this.agents.delete(placeholderId)
          existing = {
            ...pending,
            id: data.conversationId,
            label: data.role ?? pending.label,
            role: data.role ?? pending.role
          }
          break
        }
      }
    }

    const state = data.rawState ? mapRawStateToSubagentState(data.rawState) : (existing?.state ?? 'working')
    const transcriptPath = data.transcriptUri ? parseTranscriptUri(data.transcriptUri) : existing?.transcriptPath

    if (!existing) {
      existing = {
        id: data.conversationId,
        label: data.role ?? data.conversationId.slice(0, 8),
        role: data.role ?? 'Subagent',
        typeName: 'subagent',
        groupId: data.groupId,
        state,
        tokens: 0,
        startedAt: this.now(),
        settledAt: state === 'completed' || state === 'failed' || state === 'stopped' ? this.now() : undefined,
        transcriptPath
      }
    } else {
      existing.state = state
      if (data.role) {
        existing.label = data.role
        existing.role = data.role
      }
      if (transcriptPath && !existing.transcriptPath) {
        existing.transcriptPath = transcriptPath
      }
      if ((state === 'completed' || state === 'failed' || state === 'stopped') && !existing.settledAt) {
        existing.settledAt = this.now()
      }
    }

    if (transcriptPath && !existing.childTailer) {
      existing.childTailer = new AntigravityTranscriptTailer(transcriptPath)
    }

    this.agents.set(data.conversationId, existing)
    this.notifyGroup(existing.groupId)
  }

  private notifyGroup(groupId: string): void {
    const groupAgents: NativeChatSubagentEntry[] = []
    for (const agent of this.agents.values()) {
      if (agent.groupId === groupId) {
        groupAgents.push({
          id: agent.id,
          label: agent.label,
          state: agent.state,
          tokens: agent.tokens > 0 ? agent.tokens : undefined,
          startedAt: agent.startedAt,
          settledAt: agent.settledAt
        })
      }
    }

    const block: NativeChatSubagentGroupBlock = {
      type: 'subagent-group',
      groupId,
      agents: groupAgents
    }

    for (const listener of this.listeners) {
      listener(block)
    }
  }
}
