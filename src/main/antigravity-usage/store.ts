import { app } from 'electron'
import { join } from 'node:path'
import type {
  AntigravityUsageBreakdownKind,
  AntigravityUsageBreakdownRow,
  AntigravityUsageDailyPoint,
  AntigravityUsageRange,
  AntigravityUsageScope,
  AntigravityUsageSessionRow,
  AntigravityUsageSnapshot,
  AntigravityUsageSummary
} from '../../shared/antigravity-usage-types'
import type { Store } from '../persistence'
import { UsageProviderStoreLifecycle } from '../usage/usage-provider-store-lifecycle'
import { filterUsageDaily, filterUsageSessions } from '../usage/usage-scope-filters'
import { antigravityUsageProvider } from './antigravity-usage-provider'
import {
  getDefaultAntigravityUsageState,
  normalizeAntigravityUsageState
} from './persisted-state-normalization'
import {
  buildAntigravityToolBreakdown,
  buildAntigravityTopFiles,
  buildAntigravityUsageBreakdownRows,
  buildAntigravityUsageDailyPoints,
  buildAntigravityUsageRecentSessions,
  buildAntigravityUsageSummary
} from './snapshot-rollups'
import type {
  AntigravityUsageDailyAggregate,
  AntigravityUsagePersistedState,
  AntigravityUsageSession
} from './types'

let antigravityUsageFile: string | null = null

export function initAntigravityUsagePath(): void {
  antigravityUsageFile = join(app.getPath('userData'), 'orca-antigravity-usage.json')
}

function getAntigravityUsageFile(): string {
  antigravityUsageFile ??= join(app.getPath('userData'), 'orca-antigravity-usage.json')
  return antigravityUsageFile
}

export class AntigravityUsageStore extends UsageProviderStoreLifecycle<
  'processedFiles',
  AntigravityUsagePersistedState,
  'hasAnyAntigravityData'
> {
  constructor(store: Pick<Store, 'getRepos' | 'getAllWorktreeMeta'>) {
    super(store, {
      logTag: '[antigravity-usage]',
      resolveCacheFile: getAntigravityUsageFile,
      createDefaultState: getDefaultAntigravityUsageState,
      normalizeState: normalizeAntigravityUsageState,
      sourceKey: 'processedFiles',
      dataPresenceKey: 'hasAnyAntigravityData',
      scan: antigravityUsageProvider.scan
    })
  }

  getSnapshot(
    scope: AntigravityUsageScope,
    range: AntigravityUsageRange,
    recentSessionLimit = 10
  ): AntigravityUsageSnapshot {
    const daily = this.getFilteredDaily(scope, range)
    const sessions = this.getFilteredSessions(scope, range)
    return {
      scanState: this.getScanState(),
      summary: buildAntigravityUsageSummary(scope, range, daily, sessions),
      daily: buildAntigravityUsageDailyPoints(daily),
      modelBreakdown: buildAntigravityUsageBreakdownRows('model', scope, daily, sessions),
      projectBreakdown: buildAntigravityUsageBreakdownRows('project', scope, daily, sessions),
      toolBreakdown: buildAntigravityToolBreakdown(daily),
      topFiles: buildAntigravityTopFiles(sessions),
      recentSessions: buildAntigravityUsageRecentSessions(sessions, recentSessionLimit)
    }
  }

  async getSummary(
    scope: AntigravityUsageScope,
    range: AntigravityUsageRange
  ): Promise<AntigravityUsageSummary> {
    await this.refresh(false)
    return this.buildSummary(scope, range)
  }

  async getDaily(
    scope: AntigravityUsageScope,
    range: AntigravityUsageRange
  ): Promise<AntigravityUsageDailyPoint[]> {
    await this.refresh(false)
    return buildAntigravityUsageDailyPoints(this.getFilteredDaily(scope, range))
  }

  async getBreakdown(
    scope: AntigravityUsageScope,
    range: AntigravityUsageRange,
    kind: AntigravityUsageBreakdownKind
  ): Promise<AntigravityUsageBreakdownRow[]> {
    await this.refresh(false)
    return this.buildBreakdown(scope, range, kind)
  }

  async getRecentSessions(
    scope: AntigravityUsageScope,
    range: AntigravityUsageRange,
    limit = 10
  ): Promise<AntigravityUsageSessionRow[]> {
    await this.refresh(false)
    return buildAntigravityUsageRecentSessions(this.getFilteredSessions(scope, range), limit)
  }

  private buildSummary(
    scope: AntigravityUsageScope,
    range: AntigravityUsageRange
  ): AntigravityUsageSummary {
    return buildAntigravityUsageSummary(
      scope,
      range,
      this.getFilteredDaily(scope, range),
      this.getFilteredSessions(scope, range)
    )
  }

  private buildBreakdown(
    scope: AntigravityUsageScope,
    range: AntigravityUsageRange,
    kind: AntigravityUsageBreakdownKind
  ): AntigravityUsageBreakdownRow[] {
    return buildAntigravityUsageBreakdownRows(
      kind,
      scope,
      this.getFilteredDaily(scope, range),
      this.getFilteredSessions(scope, range)
    )
  }

  private getFilteredDaily(
    scope: AntigravityUsageScope,
    range: AntigravityUsageRange
  ): AntigravityUsageDailyAggregate[] {
    return filterUsageDaily(this.state.dailyAggregates, scope, range)
  }

  private getFilteredSessions(
    scope: AntigravityUsageScope,
    range: AntigravityUsageRange
  ): AntigravityUsageSession[] {
    return filterUsageSessions(this.state.sessions, scope, range)
  }
}
