import type { UsageProvider, UsageScanWorktreeRef } from '../usage/usage-provider-contract'
import {
  readUsageSourceCache,
  writeUsageSourceCache,
  type UsageSourceCacheRef
} from '../usage/usage-source-cache-file'
import { ANTIGRAVITY_USAGE_SCHEMA_VERSION } from './persisted-state-normalization'
import { scanAntigravityUsageFiles } from './scanner'
import type {
  AntigravityUsageDailyAggregate,
  AntigravityUsagePersistedFile,
  AntigravityUsageSession
} from './types'

export async function scanAntigravityUsageWithCache(
  worktrees: UsageScanWorktreeRef[],
  sourceCache: UsageSourceCacheRef
): Promise<{
  sessions: AntigravityUsageSession[]
  dailyAggregates: AntigravityUsageDailyAggregate[]
}> {
  const previousFiles = await readUsageSourceCache<AntigravityUsagePersistedFile>(sourceCache)
  const result = await scanAntigravityUsageFiles(worktrees, previousFiles)
  await writeUsageSourceCache(sourceCache, result.processedFiles)
  return {
    sessions: result.sessions,
    dailyAggregates: result.dailyAggregates
  }
}

export const antigravityUsageProvider = {
  id: 'antigravity',
  label: 'Antigravity',
  schemaVersion: ANTIGRAVITY_USAGE_SCHEMA_VERSION,
  scan: scanAntigravityUsageWithCache
} satisfies UsageProvider<AntigravityUsageSession, AntigravityUsageDailyAggregate>
