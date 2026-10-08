import type { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { agentModelCatalogSessionAccess } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import type { AcpStructuredOptions } from './acp-structured-options'

export function recordLiveSessionModelCatalog(input: {
  modelCatalog: AgentModelCatalogStore | undefined
  agent: string
  accountHomeVariable: string
  accountHomePath?: string
  options: AcpStructuredOptions
}): void {
  const { modelCatalog, agent, accountHomeVariable, accountHomePath, options } = input
  if (!modelCatalog || !accountHomePath) {
    return
  }
  const optionsResult = options.read()
  if (optionsResult.models.length === 0) {
    return
  }
  const catalogAccess = agentModelCatalogSessionAccess(
    modelCatalog,
    { agent, accountHomeVariable },
    accountHomePath
  )
  if (catalogAccess) {
    modelCatalog.recordSuccess(catalogAccess.fingerprint, agent, {
      models: optionsResult.models,
      fastModeTierByModel: new Map(),
      origin: 'live-session'
    })
  }
}
