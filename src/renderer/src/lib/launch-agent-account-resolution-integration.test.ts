import { describe, expect, it, vi } from 'vitest'
import type * as TuiAgentStartup from '@/lib/tui-agent-startup'

const mockCreateTab = vi.fn().mockReturnValue({ id: 'tab-1' })

vi.mock('@/store', () => ({
  useAppStore: {
    getState: (): unknown => ({
      activeRepoId: 'repo-1',
      activeWorktreeId: 'wt-1',
      settings: {},
      projects: [],
      tabsByWorktree: {},
      tabBarOrderByWorktree: {},
      openFiles: [],
      repos: [
        {
          id: 'repo-1',
          connectionId: null,
          path: '/repo',
          antigravityAccountId: 'acc-project-default'
        }
      ],
      createTab: mockCreateTab,
      queueTabStartupCommand: vi.fn(),
      queueTabInitialCwd: vi.fn(),
      setActiveTabType: vi.fn(),
      setTabViewMode: vi.fn(),
      setTabBarOrder: vi.fn(),
      setAgentStatus: vi.fn(),
      pasteDraftWhenAgentReady: vi.fn(),
      seedNativeChatLaunchPrompt: vi.fn(),
      seedNativeChatLaunchDraft: vi.fn(),
      markNativeChatLaunchPromptFailed: vi.fn(),
      waitForAgentReady: vi.fn().mockResolvedValue(true)
    })
  }
}))

vi.mock('@/lib/telemetry', () => ({
  tuiAgentToAgentKind: vi.fn().mockReturnValue('antigravity'),
  track: vi.fn()
}))

vi.mock('@/lib/tui-agent-startup', async (importOriginal) => {
  const actual = await importOriginal<typeof TuiAgentStartup>()
  return {
    ...actual,
    planTuiAgentStartup: vi.fn().mockReturnValue({
      launchCommand: 'agy',
      sessionOptions: {}
    })
  }
})

describe('launchAgentInNewTab account resolution integration', () => {
  it('resolves project default antigravityAccountId when not explicitly specified on launch', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      requestId: 'req-integration-1',
      agent: 'antigravity',
      worktreeId: 'repo-1::/path/wt-1'
    })

    expect(mockCreateTab).toHaveBeenCalledWith(
      'repo-1::/path/wt-1',
      undefined,
      undefined,
      expect.objectContaining({
        launchAgent: 'antigravity',
        launchAccountId: 'acc-project-default'
      })
    )
  })

  it('allows explicit launchAccountId to override project default account', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      requestId: 'req-integration-2',
      agent: 'antigravity',
      worktreeId: 'repo-1::/path/wt-1',
      launchAccountId: 'acc-override'
    })

    expect(mockCreateTab).toHaveBeenCalledWith(
      'repo-1::/path/wt-1',
      undefined,
      undefined,
      expect.objectContaining({
        launchAgent: 'antigravity',
        launchAccountId: 'acc-override'
      })
    )
  })
})
