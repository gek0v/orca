import { describe, it, expect, vi } from 'vitest'
import {
  AntigravityPermissionBridge,
  buildDecisionPayload,
  isReadOnlyTool
} from './antigravity-permission-bridge'

describe('AntigravityPermissionBridge', () => {
  it('correctly identifies read-only tools', () => {
    expect(isReadOnlyTool('view_file')).toBe(true)
    expect(isReadOnlyTool('search_web')).toBe(true)
    expect(isReadOnlyTool('get_objects_summary')).toBe(true)
    expect(isReadOnlyTool('run_command')).toBe(false)
    expect(isReadOnlyTool('write_to_file')).toBe(false)
  })

  it('builds valid json decision payloads', () => {
    expect(buildDecisionPayload('allow')).toBe('{"decision":"allow"}')
    expect(buildDecisionPayload('deny')).toBe('{"decision":"deny"}')
    expect(buildDecisionPayload('ask')).toBe('{"decision":"ask"}')
  })

  it('allows all tools when bypassPermissions is true', async () => {
    const bridge = new AntigravityPermissionBridge({ bypassPermissions: true })
    expect(bridge.decideSync('run_command')).toBe('allow')
    expect(await bridge.decide('run_command')).toBe('allow')
  })

  it('auto-approves read-only tools when autoApproveReadOnly is true', async () => {
    const bridge = new AntigravityPermissionBridge({ autoApproveReadOnly: true })
    expect(bridge.decideSync('view_file')).toBe('allow')
    expect(bridge.decideSync('run_command')).toBe('ask')
    expect(await bridge.decide('view_file')).toBe('allow')
    expect(await bridge.decide('run_command')).toBe('ask')
  })

  it('delegates to interactive approver and maps boolean responses', async () => {
    const approver = vi.fn().mockResolvedValue(true)
    const bridge = new AntigravityPermissionBridge({ interactiveApprover: approver })

    expect(bridge.decideSync('run_command')).toBeNull()
    const decision = await bridge.decide('run_command', { CommandLine: 'ls' })
    expect(approver).toHaveBeenCalledWith('run_command', { CommandLine: 'ls' })
    expect(decision).toBe('allow')

    approver.mockResolvedValueOnce(false)
    const denyDecision = await bridge.decide('run_command')
    expect(denyDecision).toBe('deny')
  })

  it('falls back to ask on approver timeout', async () => {
    const slowApprover = () => new Promise<boolean>(() => {}) // never resolves
    const bridge = new AntigravityPermissionBridge({
      interactiveApprover: slowApprover,
      timeoutMs: 20
    })

    const decision = await bridge.decide('write_to_file')
    expect(decision).toBe('ask')
  })

  it('falls back to ask on approver exception', async () => {
    const failingApprover = () => Promise.reject(new Error('IPC disconnected'))
    const bridge = new AntigravityPermissionBridge({ interactiveApprover: failingApprover })

    const decision = await bridge.decide('write_to_file')
    expect(decision).toBe('ask')
  })
})
