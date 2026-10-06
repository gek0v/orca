import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  AiVaultScanIssue,
  AiVaultSession,
  AiVaultSubagentListResult,
  AiVaultSubagentRunStatus
} from '../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import {
  wslGatedReadFile,
  wslGatedReaddir,
  wslGatedStat
} from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { recordSessionScanIssue } from './session-scan-issues'
import { sessionSortTime } from './session-scanner-accumulator'
import { antigravityConversationIdFromTranscriptPath } from './session-scanner-antigravity-paths'
import { parseAntigravitySessionFile } from './session-scanner-antigravity-parser'
import { asRecord, errorMessage, parseJsonObject } from './session-scanner-values'

const SUBAGENT_FS_PRIORITY = 'scan'
const SUBAGENT_RUNNING_RECENCY_MS = 5 * 60_000
const SAFE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/

export function antigravitySubagentsDirFor(transcriptFilePath: string): string {
  // transcriptFilePath: <brain>/<convId>/.system_generated/logs/transcript.jsonl
  // returns: <brain>/<convId>/.system_generated/subagents
  return join(dirname(dirname(transcriptFilePath)), 'subagents')
}

export function antigravityBrainDirFor(transcriptFilePath: string): string {
  // returns: <brain>
  return dirname(dirname(dirname(dirname(transcriptFilePath))))
}

export async function countAntigravitySubagents(transcriptFilePath: string): Promise<number> {
  const subagentsDir = antigravitySubagentsDirFor(transcriptFilePath)
  try {
    const entries = await wslGatedReaddir(subagentsDir, SUBAGENT_FS_PRIORITY)
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length
  } catch {
    return 0
  }
}


function resolveWorkspacePath(uris: string[] | undefined): string | null {
  if (!uris || uris.length === 0) {
    return null
  }
  const first = uris[0]
  if (typeof first !== 'string') {
    return null
  }
  if (first.startsWith('file://')) {
    try {
      return fileURLToPath(first)
    } catch {
      return first.replace(/^file:\/\/\/?/, '')
    }
  }
  return first
}

function resolveSubagentStatus(args: {
  rawState?: string
  mtimeMs?: number
  now: number
}): AiVaultSubagentRunStatus {
  const raw = args.rawState?.toLowerCase() ?? ''
  if (raw.includes('stopped') || raw.includes('killed')) {
    return 'stopped'
  }
  if (raw.includes('failed') || raw.includes('errored')) {
    return 'failed'
  }
  if (raw.includes('completed') || raw.includes('done')) {
    return 'completed'
  }
  if (args.mtimeMs && args.now - args.mtimeMs > SUBAGENT_RUNNING_RECENCY_MS) {
    return 'completed'
  }
  return 'running'
}

export async function listAntigravitySubagentSessions(args: {
  parentFilePath: string
  platform?: NodeJS.Platform
  now?: number
}): Promise<AiVaultSubagentListResult> {
  const platform = args.platform ?? process.platform
  const now = args.now ?? Date.now()
  const issues: AiVaultScanIssue[] = []
  const subagentsDir = antigravitySubagentsDirFor(args.parentFilePath)
  const brainDir = antigravityBrainDirFor(args.parentFilePath)
  const parentSessionId = antigravityConversationIdFromTranscriptPath(args.parentFilePath) ?? ''

  let entries
  try {
    entries = await wslGatedReaddir(subagentsDir, SUBAGENT_FS_PRIORITY)
  } catch (err) {
    if (err instanceof WslTranscriptFsError) {
      recordSessionScanIssue(issues, {
        agent: 'antigravity',
        path: subagentsDir,
        message: err.message
      })
    }
    return { sessions: [], issues }
  }

  const jsonFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
  if (jsonFiles.length === 0) {
    return { sessions: [], issues }
  }

  const sessions: AiVaultSession[] = []

  for (const entry of jsonFiles) {
    const jsonPath = join(subagentsDir, entry.name)
    try {
      const content = await wslGatedReadFile(jsonPath, 'utf-8', SUBAGENT_FS_PRIORITY)
      const data = parseJsonObject(content)
      if (!data) {
        continue
      }
      const rawConvId = typeof data.conversationId === 'string' ? data.conversationId : ''
      const childId = (rawConvId || entry.name.replace(/\.json$/, '')).trim()
      if (!SAFE_ID_PATTERN.test(childId)) {
        continue
      }
      const descriptor = asRecord(data.subagentDescriptor)
      const role = typeof descriptor?.role === 'string' ? descriptor.role.trim() : null
      const typeName = typeof descriptor?.typeName === 'string' ? descriptor.typeName.trim() : null
      const rawUris = Array.isArray(data.workspaceUris)
        ? data.workspaceUris.filter((u): u is string => typeof u === 'string')
        : undefined
      const workspacePath = resolveWorkspacePath(rawUris)

      const childTranscriptPath = join(
        brainDir,
        childId,
        '.system_generated',
        'logs',
        'transcript.jsonl'
      )
      let parsedSession: AiVaultSession | null = null
      let mtimeMs: number | undefined

      try {
        const fileStat = await wslGatedStat(childTranscriptPath, SUBAGENT_FS_PRIORITY)
        mtimeMs = fileStat.mtimeMs
        parsedSession = await parseAntigravitySessionFile(
          {
            path: childTranscriptPath,
            mtimeMs: fileStat.mtimeMs,
            modifiedAt: fileStat.mtime.toISOString()
          },
          platform
        )
      } catch {
        // Transcript may not be created or flushed yet
      }

      const rawState = typeof data.state === 'string' ? data.state : undefined
      const status = resolveSubagentStatus({ rawState, mtimeMs, now })
      const title = role || typeName || parsedSession?.title || 'Subagent'

      if (parsedSession) {
        sessions.push({
          ...parsedSession,
          title,
          cwd: workspacePath ?? parsedSession.cwd,
          subagent: {
            parentSessionId,
            agentType: typeName,
            status
          }
        })
      } else {
        sessions.push({
          id: `${LOCAL_EXECUTION_HOST_ID}:antigravity:${childId}:${childTranscriptPath}`,
          sessionId: childId,
          agent: 'antigravity',
          filePath: childTranscriptPath,
          title,
          cwd: workspacePath,
          branch: null,
          codexHome: null,
          executionHostId: LOCAL_EXECUTION_HOST_ID,
          executionHostPlatform: platform,
          createdAt: new Date(now).toISOString(),
          updatedAt: new Date(mtimeMs ?? now).toISOString(),
          modifiedAt: new Date(mtimeMs ?? now).toISOString(),
          model: null,
          messageCount: 0,
          previewMessages: [],
          totalTokens: 0,
          queuedMessageCount: 0,
          subagentTranscriptCount: 0,
          resumeCommand: `agy --conversation '${childId}'`,
          subagent: {
            parentSessionId,
            agentType: typeName,
            status
          }
        })
      }
    } catch (err) {
      recordSessionScanIssue(issues, {
        agent: 'antigravity',
        path: jsonPath,
        message: errorMessage(err)
      })
    }
  }

  return {
    sessions: sessions.sort((left, right) => sessionSortTime(right) - sessionSortTime(left)),
    issues
  }
}
