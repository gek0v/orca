// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../store'
import { StatsPane } from './StatsPane'

const noop = vi.fn()

let mockNavigationTarget: AppState['settingsNavigationTarget'] = null

const mockStoreState = {
  statsSummary: null,
  fetchStatsSummary: noop,
  recordFeatureInteraction: noop,
  get settingsNavigationTarget() {
    return mockNavigationTarget
  }
} satisfies Partial<AppState>

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: Partial<AppState>) => unknown) => selector(mockStoreState)
}))

vi.mock('./UsageOverviewPane', () => ({
  UsageOverviewPane: ({ onSelectProvider }: { onSelectProvider?: (id: string) => void }) => (
    <div>
      <span>Overview Pane Content</span>
      <button type="button" onClick={() => onSelectProvider?.('antigravity')}>
        Select Antigravity Card
      </button>
    </div>
  )
}))

vi.mock('./ClaudeUsagePane', () => ({ ClaudeUsagePane: () => <div>Claude Content</div> }))
vi.mock('./CodexUsagePane', () => ({ CodexUsagePane: () => <div>Codex Content</div> }))
vi.mock('./GrokUsagePane', () => ({ GrokUsagePane: () => <div>Grok Content</div> }))
vi.mock('./OpenCodeUsagePane', () => ({ OpenCodeUsagePane: () => <div>OpenCode Content</div> }))
vi.mock('./MuseUsagePane', () => ({ MuseUsagePane: () => <div>Muse Content</div> }))
vi.mock('./AntigravityUsagePane', () => ({ AntigravityUsagePane: () => <div>Antigravity Details Content</div> }))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback,
  getIntlLocale: () => 'en',
  i18n: { language: 'en' }
}))

describe('StatsPane', () => {
  afterEach(() => {
    cleanup()
    mockNavigationTarget = null
  })

  it('renders overview by default', () => {
    render(<StatsPane />)
    expect(screen.getByText('Overview Pane Content')).toBeInTheDocument()
  })

  it('switches to Antigravity detailed tab when navigated with sectionId antigravity', () => {
    mockNavigationTarget = { pane: 'stats', repoId: null, sectionId: 'antigravity' }
    render(<StatsPane />)
    expect(screen.getByText('Antigravity Details Content')).toBeInTheDocument()
  })

  it('switches to Antigravity detailed tab when onSelectProvider is triggered from overview', () => {
    render(<StatsPane />)
    expect(screen.getByText('Overview Pane Content')).toBeInTheDocument()

    const selectBtn = screen.getByText('Select Antigravity Card')
    fireEvent.click(selectBtn)

    expect(screen.getByText('Antigravity Details Content')).toBeInTheDocument()
  })
})
