import type { UsageProvider } from '../usage/usage-provider-contract'
import { ANTIGRAVITY_USAGE_SCHEMA_VERSION } from './persisted-state-normalization'
import { scanAntigravityUsageFiles } from './scanner'
import type {
  AntigravityUsageDailyAggregate,
  AntigravityUsagePersistedFile,
  AntigravityUsageSession
} from './types'

export const antigravityUsageProvider = {
  id: 'antigravity',
  label: 'Antigravity',
  schemaVersion: ANTIGRAVITY_USAGE_SCHEMA_VERSION,
  scan: scanAntigravityUsageFiles
} satisfies UsageProvider<
  'processedFiles',
  AntigravityUsagePersistedFile,
  AntigravityUsageSession,
  AntigravityUsageDailyAggregate
>
