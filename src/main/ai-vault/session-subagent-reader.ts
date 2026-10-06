import type { AiVaultSubagentListResult } from '../../shared/ai-vault-types'
import { listAntigravitySubagentSessions } from './session-scanner-antigravity-subagents'
import { listClaudeSubagentSessions } from './session-scanner-claude-subagents'
import { listOmpSubagentSessions } from './session-scanner-omp-subagent-listing'
import type { AiVaultServiceSubagentRequest } from './session-scanner-service-protocol'

export function listLocalAiVaultSubagentSessions(
  request: AiVaultServiceSubagentRequest
): Promise<AiVaultSubagentListResult> {
  if (request.agent === 'claude') {
    return listClaudeSubagentSessions({ parentFilePath: request.parentFilePath })
  }
  if (request.agent === 'antigravity') {
    return listAntigravitySubagentSessions({ parentFilePath: request.parentFilePath })
  }
  return listOmpSubagentSessions({ parentFilePath: request.parentFilePath })
}
