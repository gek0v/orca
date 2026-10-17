import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ANTIGRAVITY_INDEX_MAX_BYTES,
  antigravityCachePath,
  antigravityMetadataWorkspaces,
  readBoundedAntigravityIndex
} from './session-scanner-antigravity-metadata'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { openTranscriptReadStream, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'
import { isWslUncPath } from '../../shared/wsl-paths'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { parseJsonObject, timestampMs } from './session-scanner-values'
import { generatedSessionTitle } from './session-scanner-accumulator'
import { antigravityHistoryPromptHash } from './antigravity-history-prompt'
import SyncDatabase, { isSqliteAvailable } from '../sqlite/sync-database'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'

const HISTORY_MATCH_WINDOW_MS = 2_000

/**
 * The local-scan `readHistory`; remote scans inject their own transport. A
 * missing or unreadable history file is genuinely "no enrichment", but a gate
 * refusal must propagate so the caller records a scan issue — degrading it to
 * null lists the session with a missing cwd and no retry signal, and the
 * resolver's memo relies on the rejection to evict rather than pin a stall.
 */
export async function readLocalAntigravityHistory(
  path: string,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    throwIfAiVaultScanCancelled(signal)
    if (!isWslUncPath(path)) {
      const read = await readNodeFileWithinLimit(path, ANTIGRAVITY_INDEX_MAX_BYTES, {
        regularFileOnly: true,
        signal
      })
      return read.buffer.toString('utf8')
    }
    const stats = await wslGatedStat(path, 'scan', signal)
    if (!stats.isFile() || stats.size > ANTIGRAVITY_INDEX_MAX_BYTES) {
      return null
    }
    const input = openTranscriptReadStream(
      path,
      { end: ANTIGRAVITY_INDEX_MAX_BYTES },
      'scan',
      signal
    )
    try {
      return await readBoundedAntigravityIndex(input)
    } finally {
      input.destroy()
    }
  } catch (error) {
    throwIfAiVaultScanCancelled(signal)
    if (error instanceof Error && error.name === 'AbortError') {
      throw error
    }
    if (error instanceof WslTranscriptFsError) {
      throw error
    }
    return null
  }
}

type AntigravityDatabaseSummary = {
  cwd: string | null
  title: string | null
}

function normalizeAntigravityWorkspaceUri(uri: string): string {
  try {
    if (uri.startsWith('file://')) {
      return fileURLToPath(uri)
    }
  } catch {
    // Fall back to stripping file:// prefix if fileURLToPath throws
  }
  return uri.replace(/^file:\/\/\/?/, '')
}

function parseAntigravityWorkspaceUris(raw: string): string | null {
  try {
    const uris: unknown = JSON.parse(raw)
    if (Array.isArray(uris)) {
      for (const uri of uris) {
        if (typeof uri === 'string' && uri.trim()) {
          return normalizeAntigravityWorkspaceUri(uri.trim())
        }
      }
    }
  } catch {
    // Malformed JSON is not enriched
  }
  return null
}

function loadAntigravityDatabaseSummaries(
  historyPath: string
): Map<string, AntigravityDatabaseSummary> {
  const result = new Map<string, AntigravityDatabaseSummary>()
  const dbPath = join(dirname(historyPath), 'conversation_summaries.db')
  if (isWslUncPath(dbPath) || !existsSync(dbPath) || !isSqliteAvailable()) {
    return result
  }
  try {
    const db = new SyncDatabase(dbPath, { readonly: true, fileMustExist: true })
    try {
      db.pragma('query_only = ON')
      if (
        !tableExists(db, 'conversation_summaries') ||
        !columnExists(db, 'conversation_summaries', 'conversation_id') ||
        !columnExists(db, 'conversation_summaries', 'workspace_uris')
      ) {
        return result
      }
      const hasTitle = columnExists(db, 'conversation_summaries', 'title')
      const sql = `SELECT conversation_id, workspace_uris${hasTitle ? ', title' : ''} FROM conversation_summaries`
      for (const row of db.prepare(sql).all()) {
        const conversationId = typeof row.conversation_id === 'string' ? row.conversation_id : ''
        if (!conversationId) {
          continue
        }
        let cwd: string | null = null
        if (typeof row.workspace_uris === 'string' && row.workspace_uris.trim()) {
          cwd = parseAntigravityWorkspaceUris(row.workspace_uris)
        }
        const title = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : null
        result.set(conversationId, { cwd, title })
      }
    } finally {
      db.close()
    }
  } catch {
    // Graceful degradation when the database is locked or unreadable
  }
  return result
}

type AntigravityHistoryEntry = {
  timestampMs: number
  workspace: string
}

type AntigravityIdEntry = {
  workspace: string | null
  timestampMs: number
}

type AntigravityHistoryIndex = {
  byPrompt: Map<string, AntigravityHistoryEntry[]>
  byId: Map<string, AntigravityIdEntry>
  titlesById: Map<string, string>
  dbSummaries: Map<string, AntigravityDatabaseSummary>
}

export type AntigravityWorkspaceResolver = {
  enrich(session: AiVaultSession, historyPath: string): Promise<AiVaultSession>
}

export function createAntigravityWorkspaceResolver(
  readHistory: (historyPath: string) => Promise<string | null>
): AntigravityWorkspaceResolver {
  const indexes = new Map<string, Promise<AntigravityHistoryIndex>>()

  return {
    async enrich(session, historyPath) {
      if (session.agent !== 'antigravity') {
        return session
      }
      const genericTitle = session.title === generatedSessionTitle(session.agent, session.sessionId)
      if (session.cwd && !genericTitle) {
        return session
      }
      let index = indexes.get(historyPath)
      if (!index) {
        // Why: a read failure is transient (a stalled WSL distro refuses here),
        // so it must not be memoized — every later session under this history
        // file would inherit the rejection for the process lifetime.
        const pending: Promise<AntigravityHistoryIndex> = (async () => {
          const dbSummaries = loadAntigravityDatabaseSummaries(historyPath)
          const history = await readHistory(historyPath)
          const index = indexAntigravityHistory(history, dbSummaries)
          const [metadata, projects, lastConversations] = await Promise.all(
            ['conversation_metadata.json', 'projects.json', 'last_conversations.json'].map((name) =>
              readHistory(antigravityCachePath(historyPath, name))
            )
          )
          const paths = antigravityMetadataWorkspaces({
            metadata: metadata ?? null,
            projects: projects ?? null,
            lastConversations: lastConversations ?? null
          })
          for (const [id, path] of paths) {
            const existing = index.byId.get(id)
            if (!existing) {
              index.byId.set(id, { workspace: path, timestampMs: 0 })
            } else if (
              existing.workspace !== path &&
              (!dbSummaries.has(id) || !dbSummaries.get(id)?.cwd)
            ) {
              existing.workspace = null
            }
          }
          return index
        })().catch((error: unknown) => {
          if (indexes.get(historyPath) === pending) {
            indexes.delete(historyPath)
          }
          throw error
        })
        index = pending
        indexes.set(historyPath, pending)
      }
      const resolved = await index
      const workspace = session.cwd ?? findAntigravityWorkspace(session, resolved)
      const title =
        genericTitle && session.sessionId
          ? (resolved.titlesById.get(session.sessionId) ?? session.title)
          : session.title

      if (workspace === session.cwd && title === session.title) {
        return session
      }
      return {
        ...session,
        ...(workspace ? { cwd: workspace } : {}),
        title
      }
    }
  }
}

function indexAntigravityHistory(
  content: string | null,
  dbSummaries?: Map<string, AntigravityDatabaseSummary>
): AntigravityHistoryIndex {
  const index: AntigravityHistoryIndex = {
    byPrompt: new Map(),
    byId: new Map(),
    titlesById: new Map(),
    dbSummaries: dbSummaries ?? new Map()
  }
  if (dbSummaries) {
    for (const [id, summary] of dbSummaries) {
      if (summary.cwd) {
        index.byId.set(id, { workspace: summary.cwd, timestampMs: 0 })
      }
      if (summary.title) {
        index.titlesById.set(id, summary.title)
      }
    }
  }
  if (content && Buffer.byteLength(content) > ANTIGRAVITY_INDEX_MAX_BYTES) {
    return index
  }
  for (const line of content?.split(/\r?\n/).slice(0, 10_000) ?? []) {
    const record = parseJsonObject(line)
    const promptHash = antigravityHistoryPromptHash(record?.display)
    const workspace = typeof record?.workspace === 'string' ? record.workspace.trim() : ''
    const entryTimestampMs = timestampMs(record?.timestamp)
    const id = typeof record?.conversationId === 'string' ? record.conversationId : null
    if (!workspace || workspace.length > 4096 || !Number.isFinite(entryTimestampMs)) {
      continue
    }
    if (id) {
      const existing = index.byId.get(id)
      if (!existing) {
        index.byId.set(id, { workspace, timestampMs: entryTimestampMs })
      } else if (entryTimestampMs > existing.timestampMs) {
        index.byId.set(id, { workspace, timestampMs: entryTimestampMs })
      } else if (entryTimestampMs === existing.timestampMs && existing.workspace !== workspace) {
        existing.workspace = dbSummaries?.get(id)?.cwd ?? null
      }
    }
    if (!promptHash) {
      continue
    }
    const entries = index.byPrompt.get(promptHash) ?? []
    entries.push({ timestampMs: entryTimestampMs, workspace })
    index.byPrompt.set(promptHash, entries)
  }
  return index
}

function findAntigravityWorkspace(
  session: AiVaultSession,
  index: AntigravityHistoryIndex
): string | null {
  if (index.byId.has(session.sessionId)) {
    return index.byId.get(session.sessionId)?.workspace ?? null
  }
  const opening = session.antigravityOpeningPrompt
  const promptTimestampMs = timestampMs(opening?.timestamp)
  // Titles, createdAt and rolling previews cannot identify the original prompt.
  if (!opening || !Number.isFinite(promptTimestampMs)) {
    return null
  }
  const matches = (index.byPrompt.get(opening.hash) ?? []).filter(
    (entry) => Math.abs(entry.timestampMs - promptTimestampMs) <= HISTORY_MATCH_WINDOW_MS
  )
  // Exact prompt/time fallback is valid only when a single history row matches.
  return matches.length === 1 ? (matches[0]?.workspace ?? null) : null
}
