import { readJsonlCursor, record, type JsonlCursor } from './codex-rollout-jsonl-cursor'
import {
  finishAntigravitySubagent,
  upsertAntigravitySubagent,
  type AntigravitySubagentRoster
} from './antigravity-subagent-roster'
import {
  reconcileFromDiskSubagentsDir,
  SAFE_ANTIGRAVITY_ID_PATTERN
} from './antigravity-subagent-disk'

export { isAntigravitySubagentTranscriptDone } from './antigravity-subagent-disk'

export type AntigravitySubagentTranscriptState = {
  parent: JsonlCursor
  pendingSubagents: {
    role?: string
    typeName?: string
    model?: string
  }[]
  subagents: Map<string, { startedAt: number; description?: string; typeName?: string }>
  completedSubagents: Set<string>
}

export function createAntigravitySubagentTranscriptState(): AntigravitySubagentTranscriptState {
  return {
    parent: { offset: 0, carry: '' },
    pendingSubagents: [],
    subagents: new Map(),
    completedSubagents: new Set()
  }
}

function parseSubagentsArg(raw: unknown): { role?: string; typeName?: string; model?: string }[] {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(parsed)) {
    return []
  }
  const result: { role?: string; typeName?: string; model?: string }[] = []
  for (const item of parsed) {
    const rec = record(item)
    if (rec) {
      result.push({
        role:
          typeof rec.Role === 'string'
            ? rec.Role
            : typeof rec.role === 'string'
              ? rec.role
              : undefined,
        typeName:
          typeof rec.TypeName === 'string'
            ? rec.TypeName
            : typeof rec.type === 'string'
              ? rec.type
              : undefined,
        model:
          typeof rec.Model === 'string'
            ? rec.Model
            : typeof rec.model === 'string'
              ? rec.model
              : undefined
      })
    }
  }
  return result
}

function extractCreatedSubagentIds(content: string): string[] {
  const ids: string[] = []
  const matches = content.matchAll(/"conversationId"\s*:\s*"([A-Za-z0-9-]+)"/g)
  for (const match of matches) {
    if (match[1] && SAFE_ANTIGRAVITY_ID_PATTERN.test(match[1])) {
      ids.push(match[1])
    }
  }
  return ids
}

type ManageSubagentsListEntry = {
  conversationId: string
  role?: string
  type?: string
  state?: string
}

function parseManageSubagentsList(content: string): ManageSubagentsListEntry[] {
  const jsonMatch = content.match(/\[\s*\{.*\}\s*\]/s)
  if (!jsonMatch) {
    return []
  }
  try {
    const list = JSON.parse(jsonMatch[0])
    if (!Array.isArray(list)) {
      return []
    }
    const entries: ManageSubagentsListEntry[] = []
    for (const item of list) {
      const rec = record(item)
      if (rec) {
        const id = typeof rec.conversationId === 'string' ? rec.conversationId.trim() : ''
        if (id && SAFE_ANTIGRAVITY_ID_PATTERN.test(id)) {
          entries.push({
            conversationId: id,
            role: typeof rec.role === 'string' ? rec.role : undefined,
            type: typeof rec.type === 'string' ? rec.type : undefined,
            state: typeof rec.state === 'string' ? rec.state : undefined
          })
        }
      }
    }
    return entries
  } catch {
    return []
  }
}

export function reconcileAntigravitySubagentTranscript(
  state: AntigravitySubagentTranscriptState,
  roster: AntigravitySubagentRoster,
  transcriptPath: string | undefined
): boolean {
  if (!transcriptPath) {
    return false
  }
  let changed = false
  if (state.parent.filePath !== transcriptPath) {
    for (const id of state.subagents.keys()) {
      finishAntigravitySubagent(roster, id)
    }
    roster.clear()
    changed = true
    state.parent = { filePath: transcriptPath, offset: 0, carry: '' }
    state.pendingSubagents = []
    state.subagents.clear()
    state.completedSubagents.clear()
  }

  const now = Date.now()

  const records = readJsonlCursor(state.parent)
  if (records && records.length > 0) {
    for (const recordValue of records) {
      const content = typeof recordValue.content === 'string' ? recordValue.content : ''
      const toolCalls = Array.isArray(recordValue.tool_calls) ? recordValue.tool_calls : []

      // 1. Check for invoke_subagent or manage_subagents calls
      for (const toolCall of toolCalls) {
        const callRec = record(toolCall)
        if (callRec?.name === 'invoke_subagent') {
          const args = record(callRec.args)
          const subagentSpecs = parseSubagentsArg(args?.Subagents ?? args?.subagents)
          state.pendingSubagents.push(...subagentSpecs)
        } else if (callRec?.name === 'manage_subagents') {
          const args = record(callRec.args)
          const action =
            typeof args?.Action === 'string'
              ? args.Action
              : typeof args?.action === 'string'
                ? args.action
                : undefined
          if (action?.toLowerCase() === 'kill') {
            const rawIds = args?.ConversationIds ?? args?.conversationIds
            const ids = Array.isArray(rawIds) ? rawIds : []
            for (const id of ids) {
              if (typeof id === 'string' && SAFE_ANTIGRAVITY_ID_PATTERN.test(id)) {
                state.completedSubagents.add(id)
                state.subagents.delete(id)
                if (roster.has(id)) {
                  finishAntigravitySubagent(roster, id)
                  changed = true
                }
              }
            }
          }
        }
      }

      // 2. Check for created subagent output
      if (content.includes('Created the following subagents:')) {
        const createdIds = extractCreatedSubagentIds(content)
        for (let i = 0; i < createdIds.length; i++) {
          const id = createdIds[i]
          const spec = state.pendingSubagents.shift()
          if (id && !state.completedSubagents.has(id)) {
            state.subagents.set(id, {
              startedAt: now,
              description: spec?.role,
              typeName: spec?.typeName
            })
            upsertAntigravitySubagent(
              roster,
              id,
              {
                agentType: spec?.typeName,
                description: spec?.role,
                model: spec?.model,
                state: 'working'
              },
              now
            )
            changed = true
          }
        }
      }

      // 3. Check for manage_subagents list results
      if (content.includes('active subagent(s):')) {
        const entries = parseManageSubagentsList(content)
        for (const entry of entries) {
          if (state.completedSubagents.has(entry.conversationId)) {
            continue
          }
          const rawState = entry.state?.toLowerCase()
          if (rawState === 'idle' || rawState === 'done') {
            state.completedSubagents.add(entry.conversationId)
            state.subagents.delete(entry.conversationId)
            if (roster.has(entry.conversationId)) {
              finishAntigravitySubagent(roster, entry.conversationId)
              changed = true
            }
            continue
          }
          const stateName: 'working' | 'waiting' =
            rawState === 'waiting_for_input' ? 'waiting' : 'working'
          state.subagents.set(entry.conversationId, {
            startedAt: now,
            description: entry.role,
            typeName: entry.type
          })
          upsertAntigravitySubagent(
            roster,
            entry.conversationId,
            {
              agentType: entry.type,
              description: entry.role,
              state: stateName
            },
            now
          )
          changed = true
        }
      }

      // 4. Subagent message completion signal
      if (content.includes('[Message] timestamp=') && content.includes('sender=')) {
        const senderMatch = content.match(/sender=([A-Za-z0-9-]+)/)
        const senderId = senderMatch?.[1]
        if (senderId && SAFE_ANTIGRAVITY_ID_PATTERN.test(senderId)) {
          state.completedSubagents.add(senderId)
          state.subagents.delete(senderId)
          if (roster.has(senderId)) {
            finishAntigravitySubagent(roster, senderId)
            changed = true
          }
        }
      }
    }
  }

  // Reconcile from disk subagents directory after applying transcript events
  const diskChanged = reconcileFromDiskSubagentsDir(transcriptPath, state, roster, now)
  changed = changed || diskChanged

  return changed
}
