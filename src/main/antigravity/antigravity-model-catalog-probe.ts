import { ANTIGRAVITY_SESSION_OPTION_CATALOG } from '../../shared/agent-session-option-catalog-antigravity'
import type { AgentSessionModelOption } from '../../shared/agent-session-wire'
import type {
  AgentModelCatalogProbe,
  AgentModelCatalogSuccess
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'

export type AntigravityModelCatalogProbeDeps = {
  resolveEnvironment?: () => Promise<Record<string, string>>
  resolveCommand?: (command: string, options: { pathEnv: string; homePath: string }) => string
  /** Test seam; replaces the live short-lived ACP probe */
  runProbe?: (accountHomePath: string) => Promise<AgentModelCatalogSuccess>
}

/**
 * Lists Antigravity models at rest without spawning heavy background PyInstaller instances:
 * returns the pre-seeded catalog with reasoning effort tiers and options.
 * Live ACP sessions dynamically update advertised models on session start.
 */
export function createAntigravityModelCatalogProbe(
  deps: AntigravityModelCatalogProbeDeps
): AgentModelCatalogProbe {
  return async (accountHomePath: string): Promise<AgentModelCatalogSuccess> => {
    if (deps.runProbe) {
      return deps.runProbe(accountHomePath)
    }

    const models: AgentSessionModelOption[] = (ANTIGRAVITY_SESSION_OPTION_CATALOG.models ?? []).map(
      (model) => ({
        id: model.id,
        label: model.label,
        ...(model.description ? { description: model.description } : {}),
        isDefault: Boolean(model.isDefault),
        defaultEffort: 'high',
        efforts: [
          { value: 'low', label: 'Low', description: 'Fast responses with minimal reasoning' },
          { value: 'medium', label: 'Medium', description: 'Balanced reasoning effort' },
          { value: 'high', label: 'High', description: 'Deep, extended reasoning' }
        ]
      })
    )

    return {
      models,
      fastModeTierByModel: new Map(),
      origin: 'probe'
    }
  }
}
