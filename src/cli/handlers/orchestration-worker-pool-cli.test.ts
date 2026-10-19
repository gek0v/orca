import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.hoisted(() => vi.fn())

vi.mock('../format', () => ({
  printResult: vi.fn()
}))

import { BOOLEAN_FLAGS, parseArgs } from '../args'
import { ORCHESTRATION_WORKER_COMMAND_SPECS } from '../specs/orchestration-worker-specs'
import { ORCHESTRATION_HANDLERS } from './orchestration'
import type { RuntimeClient } from '../runtime-client'

const originalWindowsShell = process.env.ORCA_TERMINAL_WINDOWS_SHELL

describe('orchestration worker-start --pool and orca task CLI contract', () => {
  beforeEach(() => {
    callMock.mockReset()
    process.exitCode = undefined
    delete process.env.ORCA_CLI_COMMAND
    process.env.ORCA_TERMINAL_WINDOWS_SHELL = 'bash'
  })

  afterEach(() => {
    if (originalWindowsShell === undefined) {
      delete process.env.ORCA_TERMINAL_WINDOWS_SHELL
    } else {
      process.env.ORCA_TERMINAL_WINDOWS_SHELL = originalWindowsShell
    }
  })

  it('parses, forwards, and documents the --pool flag for task pool worker starts', async () => {
    const workerStartSpec = ORCHESTRATION_WORKER_COMMAND_SPECS.find(
      (spec) => spec.path.join(' ') === 'orchestration worker-start'
    )
    expect(BOOLEAN_FLAGS).toContain('pool')
    expect(workerStartSpec?.allowedFlags).toContain('pool')
    expect(workerStartSpec?.aliases).toContainEqual(['task'])
    expect(
      parseArgs(['orchestration', 'worker-start', '--task', 'task_1', '--pool']).flags.get('pool')
    ).toBe(true)

    callMock.mockResolvedValue({
      result: {
        runId: 'run_1',
        taskId: 'task_1',
        dispatchId: 'ctx_1',
        state: 'ready',
        effects: [],
        residualResources: []
      }
    })

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test harness mock client.
    const mockClient = { call: callMock } as unknown as RuntimeClient

    await ORCHESTRATION_HANDLERS['orchestration worker-start']?.({
      flags: new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['agent', 'antigravity'],
        ['pool', true],
        ['from', 'term_coord']
      ]),
      client: mockClient,
      cwd: '/tmp/repo',
      json: true
    })

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.workerStart',
      expect.objectContaining({
        task: 'task_1',
        agent: 'antigravity',
        pool: true,
        from: 'term_coord'
      })
    )
  })

  it('routes orca task alias to the worker-start handler', async () => {
    callMock.mockResolvedValue({
      result: {
        runId: 'run_1',
        taskId: 'task_1',
        dispatchId: 'ctx_1',
        state: 'ready',
        effects: [],
        residualResources: []
      }
    })

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test harness mock client.
    const mockClient = { call: callMock } as unknown as RuntimeClient

    await ORCHESTRATION_HANDLERS['task']?.({
      flags: new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['pool', true],
        ['from', 'term_coord']
      ]),
      client: mockClient,
      cwd: '/tmp/repo',
      json: true
    })

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.workerStart',
      expect.objectContaining({
        task: 'task_1',
        pool: true,
        from: 'term_coord'
      })
    )
  })
})
