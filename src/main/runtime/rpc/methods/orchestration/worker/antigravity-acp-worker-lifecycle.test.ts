import { describe, expect, it } from 'vitest'
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
})
