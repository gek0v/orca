import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  readJsonlCursor,
  record,
  type JsonlCursor
} from './codex-rollout-jsonl-cursor'
import {
  finishAntigravitySubagent,
  upsertAntigravitySubagent,
  type AntigravitySubagentRoster
} from './antigravity-subagent-roster'

const SAFE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/
const SUBAGENT_RECENCY_MS = 5 * 60_000

export type AntigravitySubagentTranscriptState = {
  parent: JsonlCursor
  pendingSubagents: {
    role?: string
    typeName?: string
    model?: string
  }[]
  subagents: Map<string, { startedAt: number; description?: string; typeName?: string }>
}

export function createAntigravitySubagentTranscriptState(): AntigravitySubagentTranscriptState {
  return {
    parent: { offset: 0, carry: '' },
    pendingSubagents: [],
    subagents: new Map()
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
    if (match[1] && SAFE_ID_PATTERN.test(match[1])) {
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
        if (id && SAFE_ID_PATTERN.test(id)) {
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

function reconcileFromDiskSubagentsDir(
  transcriptPath: string,
  roster: AntigravitySubagentRoster,
  now: number
): boolean {
  try {
    // Why: transcript is at <brain>/<convId>/.system_generated/logs/transcript.jsonl
    const systemDir = dirname(dirname(transcriptPath))
    const subagentsDir = join(systemDir, 'subagents')
    if (!existsSync(subagentsDir)) {
      return false
    }
    const entries = readdirSync(subagentsDir)
    let changed = false
    for (const entry of entries) {
      if (!entry.endsWith('.json')) {
        continue
      }
      const childId = entry.replace(/\.json$/, '')
      if (!SAFE_ID_PATTERN.test(childId)) {
        continue
      }
      try {
        const filePath = join(subagentsDir, entry)
        const content = readFileSync(filePath, 'utf-8')
        let parsedJson: unknown
        try {
          parsedJson = JSON.parse(content)
        } catch {
          continue
        }
        const data = record(parsedJson)
        if (!data) {
          continue
        }
        const descriptor = record(data.subagentDescriptor)
        const rawState = typeof data.state === 'string' ? data.state : ''
        const typeName = typeof descriptor?.typeName === 'string' ? descriptor.typeName : undefined
        const role = typeof descriptor?.role === 'string' ? descriptor.role : undefined

        // Check child transcript recency if available
        const brainDir = dirname(systemDir)
        const childTranscript = join(brainDir, childId, '.system_generated', 'logs', 'transcript.jsonl')
        let isRecent = true
        try {
          if (existsSync(childTranscript)) {
            const st = statSync(childTranscript)
            isRecent = now - st.mtimeMs <= SUBAGENT_RECENCY_MS
          }
        } catch {
          // Keep default
        }

        const isAlive = rawState === 'SUBAGENT_STATE_ALIVE' || isRecent
        const state: 'working' | 'waiting' | 'idle' = isAlive ? 'working' : 'idle'

        const existing = roster.get(childId)
        if (!existing || existing.state !== state) {
          upsertAntigravitySubagent(
            roster,
            childId,
            {
              agentType: typeName,
              description: role,
              state
            },
            now
          )
          changed = true
        }
      } catch {
        // Skip unreadable files
      }
    }
    return changed
  } catch {
    return false
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
    changed = true
    state.parent = { filePath: transcriptPath, offset: 0, carry: '' }
    state.pendingSubagents = []
    state.subagents.clear()
  }

  const now = Date.now()

  // First check disk subagents directory
  const diskChanged = reconcileFromDiskSubagentsDir(transcriptPath, roster, now)
  changed = changed || diskChanged

  const records = readJsonlCursor(state.parent)
  if (!records || records.length === 0) {
    return changed
  }

  for (const recordValue of records) {
    const content = typeof recordValue.content === 'string' ? recordValue.content : ''
    const toolCalls = Array.isArray(recordValue.tool_calls) ? recordValue.tool_calls : []

    // 1. Check for invoke_subagent calls
    for (const toolCall of toolCalls) {
      const callRec = record(toolCall)
      if (callRec?.name === 'invoke_subagent') {
        const args = record(callRec.args)
        const subagentSpecs = parseSubagentsArg(args?.Subagents ?? args?.subagents)
        state.pendingSubagents.push(...subagentSpecs)
      }
    }

    // 2. Check for created subagent output
    if (content.includes('Created the following subagents:')) {
      const createdIds = extractCreatedSubagentIds(content)
      for (let i = 0; i < createdIds.length; i++) {
        const id = createdIds[i]
        const spec = state.pendingSubagents.shift()
        if (id) {
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
        const stateName: 'working' | 'waiting' | 'idle' =
          entry.state?.toLowerCase() === 'running'
            ? 'working'
            : entry.state?.toLowerCase() === 'waiting_for_input'
              ? 'waiting'
              : 'idle'
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

    // 4. Subagent message completion/idle signal
    if (content.includes('[Message] timestamp=') && content.includes('sender=')) {
      const senderMatch = content.match(/sender=([A-Za-z0-9-]+)/)
      const senderId = senderMatch?.[1]
      if (senderId && state.subagents.has(senderId)) {
        // Child finished turn and reported back to parent
        const existing = roster.get(senderId)
        if (existing && existing.state === 'working') {
          existing.state = 'idle'
          changed = true
        }
      }
    }
  }

  return changed
}
