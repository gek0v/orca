import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../../core'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import * as localWorkerStartModule from './local-worker-start'
import type { AntigravityAccountVault } from '../../../../../antigravity/native-account-store'
import * as nativeAccountHostModule from '../../../../../antigravity/native-account-host'
import * as nativeAccountStoreModule from '../../../../../antigravity/native-account-store'

describe('orchestration worker-start task pool integration', () => {
  const h = createOrchestrationRpcHarness()
  const { coordinatorPaneKey } = h
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext

  beforeEach(() => {
    ;({ db, runtime, ctx } = h.setup(true))
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_coord' ? coordinatorPaneKey : null
    )
  })

  afterEach(() => {
    h.cleanup()
    vi.restoreAllMocks()
  })

  async function call(params: Record<string, unknown>) {
    return h.call('orchestration.workerStart', params, ctx)
  }

  it('rejects --pool with --on remote worker execution', async () => {
    const task = db.createTask({ spec: 'pool task' })
    await expect(
      call({
        task: task.id,
        from: 'term_coord',
        pool: true,
        on: 'remote-env'
      })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: '--pool is only supported for local worker execution.'
    })
  })

  it('rejects --pool when an incompatible agent is specified', async () => {
    const task = db.createTask({ spec: 'pool task' })
    await expect(
      call({
        task: task.id,
        from: 'term_coord',
        pool: true,
        agent: 'codex'
      })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: '--pool is currently only supported for --agent antigravity.'
    })
  })

  it('defaults agent to antigravity and passes launchAccountId from pool selection', async () => {
    const task = db.createTask({ spec: 'pool task' })

    const mockVault: AntigravityAccountVault = {
      accounts: [
        {
          id: 'acc-low',
          email: 'low@example.com',
          subject: 'sub-low',
          inTaskPool: true,
          lastUsage: {
            provider: 'antigravity',
            session: {
              usedPercent: 10,
              windowMinutes: 300,
              resetsAt: null,
              resetDescription: null
            },
            weekly: {
              usedPercent: 10,
              windowMinutes: 10080,
              resetsAt: null,
              resetDescription: null
            },
            updatedAt: 1000,
            error: null,
            status: 'ok'
          },
          credentials: '{}',
          createdAt: 1000,
          updatedAt: 1000,
          authMethod: 'oauth'
        },
        {
          id: 'acc-high',
          email: 'high@example.com',
          subject: 'sub-high',
          inTaskPool: true,
          lastUsage: {
            provider: 'antigravity',
            session: {
              usedPercent: 90,
              windowMinutes: 300,
              resetsAt: null,
              resetDescription: null
            },
            weekly: {
              usedPercent: 90,
              windowMinutes: 10080,
              resetsAt: null,
              resetDescription: null
            },
            updatedAt: 1000,
            error: null,
            status: 'ok'
          },
          credentials: '{}',
          createdAt: 1000,
          updatedAt: 1000,
          authMethod: 'oauth'
        }
      ],
      selectedAccountId: 'acc-high'
    }

    const mockWrite = vi.fn()
    vi.spyOn(nativeAccountHostModule, 'getAntigravityAccountVaultPath').mockReturnValue(
      '/tmp/vault'
    )
    vi.spyOn(nativeAccountStoreModule, 'createEncryptedAntigravityAccountStore').mockReturnValue({
      read: () => mockVault,
      write: mockWrite,
      updateAccountUsage: vi.fn()
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test mock cast.
    vi.spyOn(nativeAccountHostModule, 'getAntigravityAccountService').mockReturnValue({
      listAccounts: vi.fn(),
      recordUsageSnapshot: vi.fn()
    } as unknown as ReturnType<typeof nativeAccountHostModule.getAntigravityAccountService>)

    const startLocalWorkerSpy = vi
      .spyOn(localWorkerStartModule, 'startLocalWorker')
      .mockResolvedValue({
        state: 'ready',
        taskId: task.id,
        dispatchId: 'ctx_test',
        effects: [],
        residualResources: []
      })

    const result = await call({
      task: task.id,
      from: 'term_coord',
      pool: true
    })

    expect(startLocalWorkerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        launchAccountId: 'acc-low',
        params: expect.objectContaining({
          agent: 'antigravity',
          pool: true
        })
      })
    )

    expect(mockWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        accounts: expect.arrayContaining([
          expect.objectContaining({
            id: 'acc-low',
            lastUsedAt: expect.any(Number)
          })
        ])
      })
    )
    expect(result).toMatchObject({ state: 'ready' })
  })
})
