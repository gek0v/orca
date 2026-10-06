import type { AntigravityUsagePersistedState } from './types'

export const ANTIGRAVITY_USAGE_SCHEMA_VERSION = 2

export function getDefaultAntigravityUsageState(): AntigravityUsagePersistedState {
  return {
    schemaVersion: ANTIGRAVITY_USAGE_SCHEMA_VERSION,
    worktreeFingerprint: null,
    processedFiles: [],
    sessions: [],
    dailyAggregates: [],
    scanState: {
      enabled: false,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null
    }
  }
}

export function normalizeAntigravityUsageState(
  state: AntigravityUsagePersistedState
): AntigravityUsagePersistedState {
  if (state.schemaVersion === ANTIGRAVITY_USAGE_SCHEMA_VERSION) {
    return state
  }
  const defaults = getDefaultAntigravityUsageState()
  return {
    ...defaults,
    scanState: {
      ...defaults.scanState,
      enabled: state.scanState.enabled ?? defaults.scanState.enabled
    }
  }
}
