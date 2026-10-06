// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TokenUsageStatusSegment } from './TokenUsageStatusSegment'
import {
  aggregateProjectMetrics,
  aggregateRecentSessions,
  extractActiveProjectName
} from './token-usage-data-aggregation'

const mockStore = vi.hoisted(() => ({
  activeWorktreeId: 'repo1::/path/to/my-project',
  worktreesByRepo: {
    repo1: [{ id: 'repo1::/path/to/my-project', name: 'my-project', path: '/path/to/my-project' }]
  },
  claudeUsageProjectBreakdown: [
    {
      key: 'my-project',
      label: 'my-project',
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
      turns: 4,
      sessions: 1,
      estimatedCostUsd: 0.05
    }
  ],
  codexUsageProjectBreakdown: [],
  openCodeUsageProjectBreakdown: [],
  museUsageProjectBreakdown: [],
  antigravityUsageProjectBreakdown: [],
  claudeUsageRecentSessions: [
    {
      sessionId: 'sess-1',
      lastActiveAt: '2026-10-05T12:00:00.000Z',
      projectLabel: 'my-project',
      model: 'claude-3-7-sonnet',
      turns: 4,
      inputTokens: 1000,
      outputTokens: 200
    }
  ],
  codexUsageRecentSessions: [],
  openCodeUsageRecentSessions: [],
  museUsageRecentSessions: [],
  antigravityUsageRecentSessions: [],
  claudeUsageScanState: { isScanning: false },
  codexScanState: { isScanning: false },
  antigravityUsageScanState: { isScanning: false },
  fetchClaudeUsage: vi.fn(),
  fetchCodexUsage: vi.fn(),
  fetchOpenCodeUsage: vi.fn(),
  fetchMuseUsage: vi.fn(),
  fetchAntigravityUsage: vi.fn(),
  refreshClaudeUsage: vi.fn(),
  refreshCodexUsage: vi.fn(),
  refreshOpenCodeUsage: vi.fn(),
  refreshMuseUsage: vi.fn(),
  refreshAntigravityUsage: vi.fn(),
  openSettingsTarget: vi.fn(),
  openSettingsPage: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof mockStore) => unknown) => selector(mockStore)
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div role="tooltip">{children}</div>
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>
}))

describe('TokenUsageStatusSegment helpers', () => {
  it('extracts active project name from activeWorktreeId and worktreesByRepo', () => {
    expect(
      extractActiveProjectName('wt-1', {
        repoA: [{ id: 'wt-1', name: 'Alpha' }]
      })
    ).toBe('Alpha')

    expect(
      extractActiveProjectName('wt-2', {
        repoA: [{ id: 'wt-2', path: 'C:/Users/dev/Beta' }]
      })
    ).toBe('Beta')

    expect(extractActiveProjectName(null, {})).toBeNull()
  })

  it('aggregates metrics matching project name across providers', () => {
    const metrics = aggregateProjectMetrics('project-x', {
      claude: [
        {
          key: 'project-x',
          label: 'project-x',
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadTokens: 100,
          cacheWriteTokens: 50,
          turns: 3,
          sessions: 1,
          estimatedCostUsd: 0.05
        }
      ],
      codex: [
        {
          key: 'project-x',
          label: 'project-x',
          inputTokens: 500,
          outputTokens: 100,
          cachedInputTokens: 50,
          turns: 2,
          sessions: 1,
          estimatedCostUsd: 0.02
        }
      ],
      opencode: [],
      muse: []
    })

    expect(metrics.name).toBe('project-x')
    expect(metrics.inputTokens).toBe(1500)
    expect(metrics.outputTokens).toBe(300)
    expect(metrics.totalTokens).toBe(1800)
    expect(metrics.cacheTokens).toBe(200)
    expect(metrics.turns).toBe(5)
    expect(metrics.sessions).toBe(2)
    expect(metrics.cost).toBeCloseTo(0.07)
  })

  it('aggregates and sorts recent sessions across providers', () => {
    const sessions = aggregateRecentSessions(
      {
        claude: [
          {
            sessionId: 'c1',
            lastActiveAt: '2026-10-05T10:00:00Z',
            projectLabel: 'proj-a',
            model: 'claude-3-7-sonnet',
            turns: 2,
            inputTokens: 100,
            outputTokens: 20
          }
        ],
        codex: [
          {
            sessionId: 'cx1',
            lastActiveAt: '2026-10-05T11:00:00Z',
            projectLabel: 'proj-a',
            model: 'o3-mini',
            turns: 3,
            inputTokens: 200,
            outputTokens: 50
          }
        ],
        opencode: [],
        muse: []
      },
      'proj-a',
      5
    )

    expect(sessions).toHaveLength(2)
    expect(sessions[0].sessionId).toBe('cx1')
    expect(sessions[1].sessionId).toBe('c1')
  })
})

describe('TokenUsageStatusSegment component', () => {
  afterEach(cleanup)

  it('renders trigger with database icon and project token count in normal mode', () => {
    render(<TokenUsageStatusSegment iconOnly={false} />)
    const button = screen.getByRole('button', { name: /token usage/i })
    expect(button).toBeDefined()
    expect(button.textContent).toContain('1.2k')
  })

  it('renders only icon in iconOnly mode', () => {
    render(<TokenUsageStatusSegment iconOnly={true} />)
    const button = screen.getByRole('button', { name: /token usage/i })
    expect(button).toBeDefined()
    expect(button.textContent).not.toContain('1.2k')
  })

  it('renders popover content with project tokens and recent sessions', () => {
    render(<TokenUsageStatusSegment iconOnly={false} />)
    expect(screen.getByText('my-project')).toBeDefined()
    expect(screen.getByText('Project Tokens')).toBeDefined()
    expect(screen.getByText('Recent Sessions')).toBeDefined()
    expect(screen.getByText('claude-3-7-sonnet')).toBeDefined()
  })
})
