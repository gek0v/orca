import { describe, expect, it } from 'vitest'
import { terminalTitleBlocksExplicitAgentStatus } from './runtime-worktree-status-projection'

describe('terminalTitleBlocksExplicitAgentStatus', () => {
  it('returns false for null or empty title', () => {
    expect(terminalTitleBlocksExplicitAgentStatus(null)).toBe(false)
    expect(terminalTitleBlocksExplicitAgentStatus('')).toBe(false)
  })

  it('returns true for Claude management titles', () => {
    expect(terminalTitleBlocksExplicitAgentStatus('Claude agents')).toBe(true)
    expect(terminalTitleBlocksExplicitAgentStatus('Claude agents', 'antigravity')).toBe(true)
  })

  it('returns true for shell process titles when agentType is unspecified or not antigravity', () => {
    expect(terminalTitleBlocksExplicitAgentStatus('powershell.exe')).toBe(true)
    expect(terminalTitleBlocksExplicitAgentStatus('powershell.exe', 'claude')).toBe(true)
    expect(terminalTitleBlocksExplicitAgentStatus('bash')).toBe(true)
    expect(terminalTitleBlocksExplicitAgentStatus('cmd.exe')).toBe(true)
  })

  it('returns false for shell process titles when agentType is antigravity', () => {
    expect(terminalTitleBlocksExplicitAgentStatus('powershell.exe', 'antigravity')).toBe(false)
    expect(terminalTitleBlocksExplicitAgentStatus('pwsh.exe', 'antigravity')).toBe(false)
    expect(terminalTitleBlocksExplicitAgentStatus('cmd.exe', 'antigravity')).toBe(false)
    expect(terminalTitleBlocksExplicitAgentStatus('bash', 'antigravity')).toBe(false)
    expect(terminalTitleBlocksExplicitAgentStatus('zsh', 'antigravity')).toBe(false)
  })

  it('returns false for non-shell titles', () => {
    expect(terminalTitleBlocksExplicitAgentStatus('repo terminal')).toBe(false)
    expect(terminalTitleBlocksExplicitAgentStatus('Codex working')).toBe(false)
  })
})
