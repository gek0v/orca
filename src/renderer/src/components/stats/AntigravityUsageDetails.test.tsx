// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AntigravityUsageDetails } from './AntigravityUsageDetails'
import type { AntigravityUsageSummary } from '../../../../shared/antigravity-usage-types'

afterEach(cleanup)

describe('AntigravityUsageDetails', () => {
  const summary: AntigravityUsageSummary = {
    scope: 'all',
    range: 'all',
    sessions: 2,
    turns: 5,
    inputTokens: 1000,
    cachedInputTokens: 200,
    outputTokens: 500,
    reasoningOutputTokens: 100,
    totalTokens: 1500,
    estimatedCostUsd: 0.005,
    topModel: 'Gemini 2.5 Pro',
    topProject: 'Project 1',
    hasAnyAntigravityData: true,
    totalToolCalls: 12,
    toolCategoryCounts: {
      terminal: 5,
      edit: 3,
      read: 2,
      search: 2,
      subagent: 0,
      other: 0
    },
    totalFilesTouched: 2,
    toolBreakdown: [
      { category: 'terminal', label: 'Terminal commands', count: 5, percentage: 41.7 },
      { category: 'edit', label: 'File modifications', count: 3, percentage: 25 },
      { category: 'read', label: 'File reads', count: 2, percentage: 16.7 },
      { category: 'search', label: 'Web & doc searches', count: 2, percentage: 16.7 },
      { category: 'subagent', label: 'Subagents & delegation', count: 0, percentage: 0 },
      { category: 'other', label: 'Other tools', count: 0, percentage: 0 }
    ],
    topFiles: [
      { path: 'src/main.ts', reads: 2, edits: 3, totalActions: 5 },
      { path: 'src/renderer.tsx', reads: 1, edits: 0, totalActions: 1 }
    ]
  }

  it('renders tool breakdown and active files sections', () => {
    render(
      <AntigravityUsageDetails
        daily={[]}
        modelBreakdown={[]}
        projectBreakdown={[]}
        recentSessions={[]}
        summary={summary}
      />
    )

    expect(screen.getByText('By tool category')).toBeInTheDocument()
    expect(screen.getByText('Terminal commands')).toBeInTheDocument()
    expect(screen.getByText('File modifications')).toBeInTheDocument()
    expect(screen.getByText('Most active files')).toBeInTheDocument()
    expect(screen.getByText('src/main.ts')).toBeInTheDocument()
    expect(screen.getByText('src/renderer.tsx')).toBeInTheDocument()
  })
})
