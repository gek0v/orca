import { describe, expect, it, vi } from 'vitest'
import { decideWorkerStartMode } from '../../orchestration-worker-start-mode'

describe('Antigravity ACP orchestration worker mode', () => {
  const SETTINGS = {
    experimentalNativeChat: true,
    openAgentTabsInChatByDefault: true,
    experimentalStructuredNativeChat: true
  }

  it('selects structured worker mode when structured settings are enabled', () => {
    const receipt = decideWorkerStartMode({
      params: { agent: 'antigravity' },
      settings: SETTINGS
    })

    expect(receipt.mode).toBe('structured')
    expect(receipt.detail).toContain('structured chat session worker')
  })

  it('falls back to terminal worker when user default is terminal', () => {
    const receipt = decideWorkerStartMode({
      params: { agent: 'antigravity' },
      settings: { ...SETTINGS, experimentalStructuredNativeChat: false }
    })

    expect(receipt.mode).toBe('terminal')
    expect(receipt.detail).toContain('terminal agent worker')
  })

  it('falls back to terminal worker when reusing an existing terminal', () => {
    const receipt = decideWorkerStartMode({
      params: { agent: 'antigravity', terminal: 'term_1' },
      settings: SETTINGS
    })

    expect(receipt.mode).toBe('terminal')
    expect(receipt.reason).toBe('reused_terminal')
  })

  it('accepts antigravity in createStructuredWorkerSessionForWorktree', async () => {
    const { createStructuredWorkerSessionForWorktree } = await import('./worker-topology')
    const effects: never[] = []
    await expect(
      createStructuredWorkerSessionForWorktree({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mock runtime for topology test
        runtime: {
          notifyStructuredSessionJournalActivity: vi.fn()
        } as never,
        worktreeId: 'wt_1',
        agent: 'antigravity',
        dispatchId: 'd_1',
        effects
      })
    ).rejects.not.toThrow(/Structured workers support claude and codex/)
  })
})
