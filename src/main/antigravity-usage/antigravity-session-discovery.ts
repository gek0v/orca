import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database, { isSqliteAvailable } from '../sqlite/sync-database'

export type AntigravitySessionMetadata = {
  sessionId: string
  transcriptPath: string
  cwd: string | null
  model: string | null
  title: string | null
}

export type AntigravityDiscoveryOptions = {
  customRootDirs?: string[]
}

export function normalizeWorkspaceUri(uri: string): string {
  try {
    if (uri.startsWith('file://')) {
      return fileURLToPath(uri)
    }
  } catch {
    // fallback
  }
  return uri.replace(/^file:\/\/\/?/, '')
}

export function getAntigravityRootDirs(options?: AntigravityDiscoveryOptions): string[] {
  if (options?.customRootDirs && options.customRootDirs.length > 0) {
    return options.customRootDirs
  }
  const home = homedir()
  const candidates = [
    join(home, '.gemini', 'antigravity-cli'),
    join(home, '.gemini', 'antigravity')
  ]
  return candidates.filter((dir) => existsSync(dir))
}

export function readAntigravityDefaultModel(rootDir: string): string | null {
  try {
    const settingsPath = join(rootDir, 'settings.json')
    if (existsSync(settingsPath)) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: JSON parse output inspected via runtime property checks below.
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as { model?: unknown }
      if (typeof parsed.model === 'string' && parsed.model.trim()) {
        return parsed.model.trim()
      }
    }
  } catch {
    // ignore malformed settings
  }
  return null
}

export function readConversationSummaries(
  rootDir: string
): Map<string, { cwd: string | null; title: string | null }> {
  const result = new Map<string, { cwd: string | null; title: string | null }>()
  const dbPath = join(rootDir, 'conversation_summaries.db')
  if (!existsSync(dbPath) || !isSqliteAvailable()) {
    return result
  }

  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    try {
      db.pragma('query_only = ON')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SQLite query returns unknown row record array.
      const rows = db
        .prepare('SELECT conversation_id, title, workspace_uris FROM conversation_summaries')
        .all() as { conversation_id?: unknown; title?: unknown; workspace_uris?: unknown }[]

      for (const row of rows) {
        if (typeof row.conversation_id !== 'string' || !row.conversation_id) {
          continue
        }
        let cwd: string | null = null
        if (typeof row.workspace_uris === 'string' && row.workspace_uris.trim()) {
          try {
            const uris: unknown = JSON.parse(row.workspace_uris)
            if (Array.isArray(uris) && uris.length > 0 && typeof uris[0] === 'string') {
              cwd = normalizeWorkspaceUri(uris[0])
            }
          } catch {
            // fallback
          }
        }
        const title = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : null
        result.set(row.conversation_id, { cwd, title })
      }
    } finally {
      db.close()
    }
  } catch {
    // ignore sqlite read errors
  }

  return result
}

export function readHistoryWorkspaces(rootDir: string): Map<string, string> {
  const result = new Map<string, string>()
  const historyPath = join(rootDir, 'history.jsonl')
  if (!existsSync(historyPath)) {
    return result
  }

  try {
    const content = readFileSync(historyPath, 'utf8')
    const lines = content.split('\n')
    for (const line of lines) {
      if (!line.trim()) {
        continue
      }
      try {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: JSON parse output inspected via runtime property checks below.
        const item = JSON.parse(line) as { conversationId?: unknown; workspace?: unknown }
        if (
          typeof item.conversationId === 'string' &&
          typeof item.workspace === 'string' &&
          item.workspace.trim()
        ) {
          result.set(item.conversationId, item.workspace.trim())
        }
      } catch {
        // ignore bad json line
      }
    }
  } catch {
    // ignore
  }

  return result
}

export function discoverAntigravitySessions(
  options?: AntigravityDiscoveryOptions
): AntigravitySessionMetadata[] {
  const rootDirs = getAntigravityRootDirs(options)
  const sessions: AntigravitySessionMetadata[] = []

  for (const rootDir of rootDirs) {
    const defaultModel = readAntigravityDefaultModel(rootDir)
    const summaries = readConversationSummaries(rootDir)
    const historyWorkspaces = readHistoryWorkspaces(rootDir)
    const brainDir = join(rootDir, 'brain')

    if (!existsSync(brainDir)) {
      continue
    }

    let conversationDirs: string[] = []
    try {
      conversationDirs = readdirSync(brainDir)
    } catch {
      continue
    }

    for (const convId of conversationDirs) {
      const transcriptPath = join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl')
      const fallbackTranscriptPath = join(
        brainDir,
        convId,
        '.system_generated',
        'logs',
        'transcript_full.jsonl'
      )

      let resolvedTranscript = ''
      if (existsSync(transcriptPath)) {
        resolvedTranscript = transcriptPath
      } else if (existsSync(fallbackTranscriptPath)) {
        resolvedTranscript = fallbackTranscriptPath
      } else {
        continue
      }

      const summary = summaries.get(convId)
      const cwd = summary?.cwd ?? historyWorkspaces.get(convId) ?? null
      const title = summary?.title ?? null

      sessions.push({
        sessionId: convId,
        transcriptPath: resolvedTranscript,
        cwd,
        model: defaultModel,
        title
      })
    }
  }

  return sessions
}
