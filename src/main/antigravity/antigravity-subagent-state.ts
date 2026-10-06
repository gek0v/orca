import { fileURLToPath } from 'node:url'
import type { NativeChatSubagentState } from '../../shared/native-chat-types'
import type { AntigravityTranscriptTailer } from './antigravity-transcript-tailer'

export type TrackedSubagent = {
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

export type DiscoveredSubagentDetails = {
  conversationId: string
  role?: string
  transcriptUri?: string
  rawState?: string
  groupId: string
}

export function mapRawStateToSubagentState(rawState: string): NativeChatSubagentState {
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

export function parseTranscriptUri(uri: string): string {
  if (uri.startsWith('file://')) {
    try {
      return fileURLToPath(uri)
    } catch {
      return uri.replace(/^file:\/\/\/?/, '')
    }
  }
  return uri
}

export function extractSubagentDetailsFromContent(
  content: string,
  currentGroupId: string
): DiscoveredSubagentDetails[] {
  const conversationIdMatches = content.match(/"conversationId":\s*"([^"]+)"/g)
  if (!conversationIdMatches) {
    return []
  }

  const results: DiscoveredSubagentDetails[] = []
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

    results.push({
      conversationId,
      role: roleMatch ? roleMatch[1] : undefined,
      transcriptUri: logUriMatch ? logUriMatch[1] : undefined,
      rawState: stateMatch ? stateMatch[1] : undefined,
      groupId: currentGroupId
    })
  }

  return results
}
