import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { AntigravityAccountTarget } from '../../../shared/antigravity-account-types'
import { callAntigravityAccounts } from '@/runtime/runtime-antigravity-accounts-client'
import { setCachedAntigravityAccountsState } from '@/hooks/useAntigravityAccounts'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'

export type LocatedAntigravityTab = {
  tab: TerminalTab
  worktreeId: string
  groupId?: string
}

export type AntigravityTabLookupState = Partial<
  Pick<
    AppState,
    | 'tabsByWorktree'
    | 'unifiedTabsByWorktree'
    | 'activeTabIdByWorktree'
    | 'activeWorktreeId'
    | 'activeTabId'
  >
>

export function findActiveAntigravityTab(
  state: AntigravityTabLookupState
): LocatedAntigravityTab | null {
  const tabsByWorktree = state.tabsByWorktree ?? {}
  const unifiedTabsByWorktree = state.unifiedTabsByWorktree ?? {}
  const activeTabIdByWorktree = state.activeTabIdByWorktree ?? {}
  const currentWorktreeId = state.activeWorktreeId
  const activeTabId = currentWorktreeId
    ? (activeTabIdByWorktree[currentWorktreeId] ?? state.activeTabId)
    : state.activeTabId

  if (currentWorktreeId && activeTabId) {
    const tabs = tabsByWorktree[currentWorktreeId] ?? []
    const tab = tabs.find((t) => t.id === activeTabId)
    if (tab?.launchAgent === 'antigravity') {
      const unified = (unifiedTabsByWorktree[currentWorktreeId] ?? []).find(
        (u) => u.contentType === 'terminal' && u.entityId === tab.id
      )
      return { tab, worktreeId: currentWorktreeId, groupId: unified?.groupId }
    }
  }

  if (currentWorktreeId) {
    const tabs = tabsByWorktree[currentWorktreeId] ?? []
    const tab = tabs.find((t) => t.launchAgent === 'antigravity')
    if (tab) {
      const unified = (unifiedTabsByWorktree[currentWorktreeId] ?? []).find(
        (u) => u.contentType === 'terminal' && u.entityId === tab.id
      )
      return { tab, worktreeId: currentWorktreeId, groupId: unified?.groupId }
    }
  }

  for (const [wId, tabs] of Object.entries(tabsByWorktree)) {
    const tab = tabs.find((t) => t.launchAgent === 'antigravity')
    if (tab) {
      const unified = (unifiedTabsByWorktree[wId] ?? []).find(
        (u) => u.contentType === 'terminal' && u.entityId === tab.id
      )
      return { tab, worktreeId: wId, groupId: unified?.groupId }
    }
  }

  return null
}

export function findAntigravityTabById(
  state: AntigravityTabLookupState,
  tabId: string
): LocatedAntigravityTab | null {
  const tabsByWorktree = state.tabsByWorktree ?? {}
  const unifiedTabsByWorktree = state.unifiedTabsByWorktree ?? {}

  for (const [wId, tabs] of Object.entries(tabsByWorktree)) {
    const tab = tabs.find((t) => t.id === tabId)
    if (tab) {
      const unified = (unifiedTabsByWorktree[wId] ?? []).find(
        (u) => u.contentType === 'terminal' && u.entityId === tab.id
      )
      return { tab, worktreeId: wId, groupId: unified?.groupId }
    }
  }
  for (const [wId, tabs] of Object.entries(unifiedTabsByWorktree)) {
    const unified = tabs.find((t) => t.contentType === 'terminal' && t.entityId === tabId)
    if (unified) {
      const fallbackTab: TerminalTab = {
        id: tabId,
        ptyId: null,
        worktreeId: wId,
        title: unified.customLabel ?? 'Terminal',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: Date.now()
      }
      return { tab: fallbackTab, worktreeId: wId, groupId: unified.groupId }
    }
  }
  return null
}

export async function switchAntigravityAccountAndRestartSession(args: {
  targetAccountId: string
  target?: AntigravityAccountTarget
  tabId?: string
}): Promise<{ restarted: boolean }> {
  const accountTarget = args.target ?? { runtime: 'host' }
  const res = await callAntigravityAccounts(
    { kind: 'local' },
    accountTarget,
    'Select',
    args.targetAccountId
  )
  setCachedAntigravityAccountsState(res)

  const store = useAppStore.getState()
  if (store.refreshRateLimits) {
    void store.refreshRateLimits()
  }

  const located = args.tabId
    ? findAntigravityTabById(store, args.tabId)
    : findActiveAntigravityTab(store)

  if (!located) {
    return { restarted: false }
  }

  const { tab, worktreeId, groupId } = located
  const initialCwd = tab.startupCwd

  store.closeTab(tab.id)
  launchAgentInNewTab({
    requestId: newAgentLaunchRequestId(),
    agent: 'antigravity',
    worktreeId,
    launchAccountId: args.targetAccountId,
    groupId,
    initialCwd,
    launchSource: 'tab_bar_quick_launch'
  })

  return { restarted: true }
}
