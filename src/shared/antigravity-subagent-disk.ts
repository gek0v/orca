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
const SUBAGENT_RECENCY_MS = 15 * 60_000

export function isSubagentCompletionMessage(content: string): boolean {
  if (
    /\b(?:status update|progress report|liveness|iteration|standing by|standby|en espera|esperando(?: a)?|actualizaci[oó]n|reporte de progreso|informe de estado)\b/i.test(
      content
    )
  ) {
    return false
  }
  return (
    /\b(?:(?:task|mission|work|implementation|survey|review|audit|analysis|refactor|investigation|job|tarea|misi[oó]n|trabajo|implementaci[oó]n|revisi[oó]n|auditor[ií]a|an[aá]lisis)(?: \w+)? (?:is |est[aá] )?(?:complete|completed|finished|done|completad[oa]|finalizad[oa]|terminad[oa]|concluid[oa])|all tasks? (?:are )?(?:complete|completed|finished|done)|todas las tareas (?:est[aá]n )?completadas|completed successfully|completad[oa] con [eé]xito|100% completad[oa]|completad[oa] al 100%|acciones completadas|soluci[oó]n completa|ready to merge|listo para merge|listo para fusionar|misi[oó]n cumplida|todo (?:completado|terminado|finalizado))\b/i.test(
      content
    ) || /\btask \d+ complete\b/i.test(content)
  )
}

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
    if (!rec) {
      return false
    }
    const status = typeof rec.status === 'string' ? rec.status.toUpperCase() : undefined
    if (status === 'ERROR') {
      return true
    }
    if (Array.isArray(rec.tool_calls) && rec.tool_calls.length > 0) {
      return false
    }
    const type = typeof rec.type === 'string' ? rec.type.toUpperCase() : undefined
    if (type !== 'PLANNER_RESPONSE') {
      return false
    }
    const content = typeof rec.content === 'string' ? rec.content : ''
    if (
      /\b(?:status update|progress report|liveness|iteration|standing by|en espera|esperando(?: a)?|standby)\b/i.test(
        content
      )
    ) {
      return false
    }
    return status === 'DONE'
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
    const brainDir = dirname(dirname(systemDir))
    const rootSubagentsDir = join(systemDir, 'subagents')
    if (!existsSync(rootSubagentsDir)) {
      return false
    }

    let changed = false
    const visitedDirs = new Set<string>()
    const queue: { dir: string; depth: number }[] = [{ dir: rootSubagentsDir, depth: 0 }]

    while (queue.length > 0) {
      const current = queue.shift()
      if (!current || visitedDirs.has(current.dir) || current.depth > 4) {
        continue
      }
      visitedDirs.add(current.dir)

      if (!existsSync(current.dir)) {
        continue
      }

      let entries: string[] = []
      try {
        entries = readdirSync(current.dir)
      } catch {
        continue
      }

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
          const filePath = join(current.dir, entry)
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
          const typeName =
            typeof descriptor?.typeName === 'string' ? descriptor.typeName : undefined
          const role = typeof descriptor?.role === 'string' ? descriptor.role : undefined

          const diskState = typeof data.state === 'string' ? data.state.toUpperCase() : undefined
          const diskIsTerminal =
            diskState === 'SUBAGENT_STATE_KILLED' ||
            diskState === 'SUBAGENT_STATE_DONE' ||
            diskState === 'SUBAGENT_STATE_COMPLETED'

          // Check child transcript recency if available
          const childSystemDir = join(brainDir, childId, '.system_generated')
          const childTranscript = join(childSystemDir, 'logs', 'transcript.jsonl')
          let isStale = false
          const childIsDone = diskIsTerminal || isAntigravitySubagentTranscriptDone(childTranscript)
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

          // Traverse into child's own subagents directory if it has spawned nested subagents
          const nestedSubagentsDir = join(childSystemDir, 'subagents')
          if (existsSync(nestedSubagentsDir) && !visitedDirs.has(nestedSubagentsDir)) {
            queue.push({ dir: nestedSubagentsDir, depth: current.depth + 1 })
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
    return changed
  } catch {
    return false
  }
}
