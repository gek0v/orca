import type { TuiAgent } from '../../../shared/tui-agent'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'

type LaunchAccountResolutionStore = {
  repos?: readonly { id: string; antigravityAccountId?: string | null }[]
  worktreesByRepo?: Record<string, readonly { id: string }[]>
}

export function resolveDefaultLaunchAccountId(
  store: LaunchAccountResolutionStore,
  agent: TuiAgent,
  worktreeId: string,
  explicitAccountId?: string
): string | undefined {
  if (explicitAccountId) {
    return explicitAccountId
  }
  if (agent !== 'antigravity') {
    return undefined
  }
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  let repo = store.repos?.find((r) => r.id === repoId)
  if (!repo && store.worktreesByRepo) {
    for (const [rId, worktrees] of Object.entries(store.worktreesByRepo)) {
      if (worktrees.some((wt) => wt.id === worktreeId)) {
        repo = store.repos?.find((r) => r.id === rId)
        break
      }
    }
  }
  return repo?.antigravityAccountId ?? undefined
}
