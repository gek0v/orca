import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { record } from './codex-rollout-jsonl-cursor'
import {
  finishAntigravitySubagent,
  upsertAntigravitySubagent,
  type AntigravitySubagentRoster
} from './antigravity-subagent-roster'
import type { AntigravitySubagentTranscriptState } from './antigravity-subagent-transcript'

export const SAFE_ANTIGRAVITY_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/
const SUBAGENT_RECENCY_MS = 5 * 60_000

export function isAntigravitySubagentTranscriptDone(transcriptPath: string): boolean {
  try {
    if (!existsSync(transcriptPath)) {
      return false
    }
    const stat = statSync(transcriptPath)
    if (stat.size === 0) {
      return false
    }
    const readSize = Math.min(stat.size, 4096)
    const buf = Buffer.alloc(readSize)
    const fd = openSync(transcriptPath, 'r')
    try {
      readSync(fd, buf, 0, readSize, stat.size - readSize)
    } finally {
      closeSync(fd)
    }
    const text = buf.toString('utf8').trim()
    const lastLine = text.split('\n').pop()
    if (!lastLine) {
      return false
    }
    const rec = record(JSON.parse(lastLine))
    const status = typeof rec?.status === 'string' ? rec.status.toUpperCase() : undefined
    return status === 'DONE' || status === 'ERROR'
  } catch {
    return false
  }
}

export function reconcileFromDiskSubagentsDir(
  transcriptPath: string,
  state: AntigravitySubagentTranscriptState,
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
      if (!SAFE_ANTIGRAVITY_ID_PATTERN.test(childId)) {
        continue
      }
      if (state.completedSubagents.has(childId)) {
        if (roster.has(childId)) {
          finishAntigravitySubagent(roster, childId)
          changed = true
        }
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
        const typeName = typeof descriptor?.typeName === 'string' ? descriptor.typeName : undefined
        const role = typeof descriptor?.role === 'string' ? descriptor.role : undefined

        // Check child transcript recency if available
        const brainDir = dirname(dirname(systemDir))
        const childTranscript = join(
          brainDir,
          childId,
          '.system_generated',
          'logs',
          'transcript.jsonl'
        )
        let isStale = false
        const childIsDone = isAntigravitySubagentTranscriptDone(childTranscript)
        try {
          if (existsSync(childTranscript)) {
            const st = statSync(childTranscript)
            isStale = now - st.mtimeMs > SUBAGENT_RECENCY_MS
          } else {
            const st = statSync(filePath)
            isStale = now - st.mtimeMs > SUBAGENT_RECENCY_MS
          }
        } catch {
          // Keep default
        }

        if (childIsDone || isStale) {
          state.completedSubagents.add(childId)
          state.subagents.delete(childId)
          if (roster.has(childId)) {
            finishAntigravitySubagent(roster, childId)
            changed = true
          }
          continue
        }

        const existing = roster.get(childId)
        if (!existing) {
          state.subagents.set(childId, {
            startedAt: now,
            description: role,
            typeName
          })
          upsertAntigravitySubagent(
            roster,
            childId,
            {
              agentType: typeName,
              description: role,
              state: 'working'
            },
            now
          )
          changed = true
        } else if ((!existing.agentType && typeName) || (!existing.description && role)) {
          upsertAntigravitySubagent(
            roster,
            childId,
            {
              agentType: existing.agentType ?? typeName,
              description: existing.description ?? role,
              state: existing.state
            },
            existing.startedAt
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
