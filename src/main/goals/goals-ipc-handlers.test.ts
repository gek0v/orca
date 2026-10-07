import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import {
  registerGoalsIpcHandlers,
  type GoalsIpcTarget,
  type GoalsManagerTarget,
  type GoalsRunnerTarget
} from './goals-ipc-handlers'
import { GOALS_IPC_CHANNELS } from '../../shared/goals/goals-ipc'
import { GoalSchema, type WorkspaceGoalsData } from '../../shared/goals/goals-schema'
import type { WorktreeGoalsService } from './worktree-goals-service'
import type { GoalValidationResult } from './goals-validation-runner'

type IpcHandlerFn = (_event: unknown, ...args: unknown[]) => Promise<unknown>

describe('goals-ipc-handlers', () => {
  let handlers: Map<string, IpcHandlerFn>
  let fakeIpcMain: GoalsIpcTarget
  let mockService: {
    workspacePath: string
    loadGoals: Mock<() => Promise<WorkspaceGoalsData>>
    updateGoals: Mock<
      (
        updater: (current: WorkspaceGoalsData) => WorkspaceGoalsData | Promise<WorkspaceGoalsData>
      ) => Promise<WorkspaceGoalsData>
    >
    saveGoals: Mock<(data: WorkspaceGoalsData) => Promise<void>>
    projectCurrentGoalFile: Mock<() => Promise<void>>
    onExternalChange: Mock<(callback: (data: WorkspaceGoalsData) => void) => () => void>
  }
  let mockManager: GoalsManagerTarget
  let mockRunner: GoalsRunnerTarget
  let broadcastEvent: Mock<(channel: string, payload: unknown) => void>
  let externalChangeCallback: ((data: WorkspaceGoalsData) => void) | null = null

  beforeEach(() => {
    handlers = new Map<string, IpcHandlerFn>()
    externalChangeCallback = null

    fakeIpcMain = {
      handle: vi.fn((channel: string, handler: IpcHandlerFn) => {
        handlers.set(channel, handler)
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel)
      })
    }

    mockService = {
      workspacePath: '/mock/workspace',
      loadGoals: vi.fn<() => Promise<WorkspaceGoalsData>>(),
      updateGoals:
        vi.fn<
          (
            updater: (
              current: WorkspaceGoalsData
            ) => WorkspaceGoalsData | Promise<WorkspaceGoalsData>
          ) => Promise<WorkspaceGoalsData>
        >(),
      saveGoals: vi.fn<(data: WorkspaceGoalsData) => Promise<void>>(),
      projectCurrentGoalFile: vi.fn<() => Promise<void>>(),
      onExternalChange: vi.fn((callback: (data: WorkspaceGoalsData) => void) => {
        externalChangeCallback = callback
        return () => {
          externalChangeCallback = null
        }
      })
    }

    mockManager = {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mockService fulfills the subset of WorktreeGoalsService used by the IPC handlers.
      getService: vi.fn(() => mockService as unknown as WorktreeGoalsService)
    }

    mockRunner = {
      runValidation: vi.fn<() => Promise<GoalValidationResult>>()
    }

    broadcastEvent = vi.fn<(channel: string, payload: unknown) => void>()
  })

  it('registers all required IPC channel handlers', () => {
    registerGoalsIpcHandlers(fakeIpcMain, mockManager, mockRunner, broadcastEvent)

    expect(fakeIpcMain.handle).toHaveBeenCalledWith(GOALS_IPC_CHANNELS.GET, expect.any(Function))
    expect(fakeIpcMain.handle).toHaveBeenCalledWith(
      GOALS_IPC_CHANNELS.CREATE_GOAL,
      expect.any(Function)
    )
    expect(fakeIpcMain.handle).toHaveBeenCalledWith(
      GOALS_IPC_CHANNELS.SET_ACTIVE,
      expect.any(Function)
    )
    expect(fakeIpcMain.handle).toHaveBeenCalledWith(
      GOALS_IPC_CHANNELS.TOGGLE_SUBTASK,
      expect.any(Function)
    )
    expect(fakeIpcMain.handle).toHaveBeenCalledWith(
      GOALS_IPC_CHANNELS.UPDATE_GOAL,
      expect.any(Function)
    )
    expect(fakeIpcMain.handle).toHaveBeenCalledWith(
      GOALS_IPC_CHANNELS.RUN_VALIDATION,
      expect.any(Function)
    )
  })

  it('handles goals:get by loading goals from worktree service', async () => {
    registerGoalsIpcHandlers(fakeIpcMain, mockManager, mockRunner, broadcastEvent)
    const expectedData: WorkspaceGoalsData = {
      activeGoalId: 'goal-1',
      goals: []
    }
    mockService.loadGoals.mockResolvedValue(expectedData)

    const handler = handlers.get(GOALS_IPC_CHANNELS.GET)
    expect(handler).toBeDefined()

    const result = await handler!(null, { workspacePath: '/mock/workspace' })

    expect(mockManager.getService).toHaveBeenCalledWith('/mock/workspace')
    expect(mockService.loadGoals).toHaveBeenCalled()
    expect(result).toEqual(expectedData)
  })

  it('handles goals:create-goal and sets activeGoalId if none set', async () => {
    registerGoalsIpcHandlers(fakeIpcMain, mockManager, mockRunner, broadcastEvent)

    const initialData: WorkspaceGoalsData = {
      activeGoalId: null,
      goals: []
    }

    mockService.updateGoals.mockImplementation(async (updater) => {
      return updater(initialData)
    })

    const handler = handlers.get(GOALS_IPC_CHANNELS.CREATE_GOAL)
    const rawResult = await handler!(null, {
      workspacePath: '/mock/workspace',
      title: 'First Goal',
      description: 'Goal description',
      subtasks: ['Task A', 'Task B'],
      validationCommand: 'npm test'
    })
    const created = GoalSchema.parse(rawResult)

    expect(created.title).toBe('First Goal')
    expect(created.description).toBe('Goal description')
    expect(created.subtasks).toHaveLength(2)
    expect(created.subtasks[0].title).toBe('Task A')
    expect(created.subtasks[0].completed).toBe(false)
    expect(created.validation?.command).toBe('npm test')
    expect(created.validation?.status).toBe('idle')
    expect(mockService.updateGoals).toHaveBeenCalled()
  })

  it('handles goals:set-active by updating activeGoalId', async () => {
    registerGoalsIpcHandlers(fakeIpcMain, mockManager, mockRunner, broadcastEvent)

    const initialData: WorkspaceGoalsData = {
      activeGoalId: 'g-1',
      goals: [
        {
          id: 'g-1',
          title: 'Goal 1',
          status: 'in_progress',
          subtasks: [],
          createdAt: 10,
          updatedAt: 10
        },
        {
          id: 'g-2',
          title: 'Goal 2',
          status: 'pending',
          subtasks: [],
          createdAt: 20,
          updatedAt: 20
        }
      ]
    }

    const stateHolder = { current: initialData }
    mockService.updateGoals.mockImplementation(async (updater) => {
      stateHolder.current = await updater(stateHolder.current)
      return stateHolder.current
    })

    const handler = handlers.get(GOALS_IPC_CHANNELS.SET_ACTIVE)
    await handler!(null, {
      workspacePath: '/mock/workspace',
      goalId: 'g-2'
    })

    expect(stateHolder.current.activeGoalId).toBe('g-2')
  })

  it('handles goals:toggle-subtask and marks goal completed when all tasks complete', async () => {
    registerGoalsIpcHandlers(fakeIpcMain, mockManager, mockRunner, broadcastEvent)

    const initialData: WorkspaceGoalsData = {
      activeGoalId: 'g-1',
      goals: [
        {
          id: 'g-1',
          title: 'Goal 1',
          status: 'in_progress',
          subtasks: [
            { id: 't-1', title: 'Task 1', completed: true },
            { id: 't-2', title: 'Task 2', completed: false }
          ],
          createdAt: 10,
          updatedAt: 10
        }
      ]
    }

    const stateHolder = { current: initialData }
    mockService.updateGoals.mockImplementation(async (updater) => {
      stateHolder.current = await updater(stateHolder.current)
      return stateHolder.current
    })

    const handler = handlers.get(GOALS_IPC_CHANNELS.TOGGLE_SUBTASK)
    await handler!(null, {
      workspacePath: '/mock/workspace',
      goalId: 'g-1',
      subtaskId: 't-2',
      completed: true
    })

    const goal = stateHolder.current.goals.find((g) => g.id === 'g-1')
    expect(goal?.subtasks[1].completed).toBe(true)
    expect(goal?.status).toBe('completed')
  })

  it('reverts completed goal to in_progress if a subtask is unticked', async () => {
    registerGoalsIpcHandlers(fakeIpcMain, mockManager, mockRunner, broadcastEvent)

    const initialData: WorkspaceGoalsData = {
      activeGoalId: 'g-1',
      goals: [
        {
          id: 'g-1',
          title: 'Goal 1',
          status: 'completed',
          subtasks: [
            { id: 't-1', title: 'Task 1', completed: true },
            { id: 't-2', title: 'Task 2', completed: true }
          ],
          createdAt: 10,
          updatedAt: 10
        }
      ]
    }

    const stateHolder = { current: initialData }
    mockService.updateGoals.mockImplementation(async (updater) => {
      stateHolder.current = await updater(stateHolder.current)
      return stateHolder.current
    })

    const handler = handlers.get(GOALS_IPC_CHANNELS.TOGGLE_SUBTASK)
    await handler!(null, {
      workspacePath: '/mock/workspace',
      goalId: 'g-1',
      subtaskId: 't-2',
      completed: false
    })

    const goal = stateHolder.current.goals.find((g) => g.id === 'g-1')
    expect(goal?.subtasks[1].completed).toBe(false)
    expect(goal?.status).toBe('in_progress')
  })

  it('handles goals:update-goal by applying partial updates', async () => {
    registerGoalsIpcHandlers(fakeIpcMain, mockManager, mockRunner, broadcastEvent)

    const initialData: WorkspaceGoalsData = {
      activeGoalId: 'g-1',
      goals: [
        {
          id: 'g-1',
          title: 'Initial Title',
          description: 'Old desc',
          status: 'in_progress',
          subtasks: [],
          createdAt: 10,
          updatedAt: 10
        }
      ]
    }

    const stateHolder = { current: initialData }
    mockService.updateGoals.mockImplementation(async (updater) => {
      stateHolder.current = await updater(stateHolder.current)
      return stateHolder.current
    })

    const handler = handlers.get(GOALS_IPC_CHANNELS.UPDATE_GOAL)
    await handler!(null, {
      workspacePath: '/mock/workspace',
      goalId: 'g-1',
      updates: {
        title: 'New Title',
        description: 'Updated desc'
      }
    })

    const goal = stateHolder.current.goals.find((g) => g.id === 'g-1')
    expect(goal?.title).toBe('New Title')
    expect(goal?.description).toBe('Updated desc')
    expect(goal?.id).toBe('g-1')
    expect(goal?.createdAt).toBe(10)
  })

  it('handles goals:run-validation by delegating to validation runner and saving result', async () => {
    registerGoalsIpcHandlers(fakeIpcMain, mockManager, mockRunner, broadcastEvent)

    const initialData: WorkspaceGoalsData = {
      activeGoalId: 'g-1',
      goals: [
        {
          id: 'g-1',
          title: 'Goal 1',
          status: 'in_progress',
          subtasks: [],
          validation: {
            command: 'pnpm test',
            status: 'idle'
          },
          createdAt: 10,
          updatedAt: 10
        }
      ]
    }

    mockService.loadGoals.mockResolvedValue(initialData)

    const validationResult: GoalValidationResult = {
      command: 'pnpm test',
      status: 'success',
      exitCode: 0,
      summaryTail: '1 test passed',
      lastRunAt: 5000
    }
    vi.mocked(mockRunner.runValidation).mockResolvedValue(validationResult)

    const stateHolder = { current: initialData }
    mockService.updateGoals.mockImplementation(async (updater) => {
      stateHolder.current = await updater(stateHolder.current)
      return stateHolder.current
    })

    const handler = handlers.get(GOALS_IPC_CHANNELS.RUN_VALIDATION)
    const result = await handler!(null, {
      workspacePath: '/mock/workspace',
      goalId: 'g-1'
    })

    expect(mockRunner.runValidation).toHaveBeenCalledWith('/mock/workspace', 'pnpm test', 'g-1')
    expect(result).toEqual(validationResult)
    const goal = stateHolder.current.goals.find((g) => g.id === 'g-1')
    expect(goal?.validation).toEqual(validationResult)
  })

  it('broadcasts goals:changed when service emits external changes', async () => {
    registerGoalsIpcHandlers(fakeIpcMain, mockManager, mockRunner, broadcastEvent)

    // Trigger service resolution
    const getHandler = handlers.get(GOALS_IPC_CHANNELS.GET)
    mockService.loadGoals.mockResolvedValue({ activeGoalId: null, goals: [] })
    await getHandler!(null, { workspacePath: '/mock/workspace' })

    expect(mockService.onExternalChange).toHaveBeenCalled()
    expect(externalChangeCallback).toBeTypeOf('function')

    const externalData: WorkspaceGoalsData = {
      activeGoalId: 'external-g',
      goals: []
    }
    externalChangeCallback!(externalData)

    expect(broadcastEvent).toHaveBeenCalledWith(GOALS_IPC_CHANNELS.CHANGED, {
      workspacePath: '/mock/workspace',
      data: externalData
    })
  })

  it('supports positional arguments calling convention', async () => {
    registerGoalsIpcHandlers(fakeIpcMain, mockManager, mockRunner, broadcastEvent)

    const initialData: WorkspaceGoalsData = {
      activeGoalId: 'g-1',
      goals: [
        {
          id: 'g-1',
          title: 'Goal 1',
          status: 'in_progress',
          subtasks: [{ id: 't-1', title: 'Task 1', completed: false }],
          createdAt: 10,
          updatedAt: 10
        }
      ]
    }

    const stateHolder = { current: initialData }
    mockService.updateGoals.mockImplementation(async (updater) => {
      stateHolder.current = await updater(stateHolder.current)
      return stateHolder.current
    })

    const toggleHandler = handlers.get(GOALS_IPC_CHANNELS.TOGGLE_SUBTASK)
    await toggleHandler!(null, '/mock/workspace', 'g-1', 't-1', true)

    expect(stateHolder.current.goals[0].subtasks[0].completed).toBe(true)
  })

  it('handles goals:delete-goal and clears activeGoalId if active goal is deleted', async () => {
    registerGoalsIpcHandlers(fakeIpcMain, mockManager, mockRunner, broadcastEvent)

    const initialData: WorkspaceGoalsData = {
      activeGoalId: 'g-1',
      goals: [
        {
          id: 'g-1',
          title: 'Goal 1',
          status: 'in_progress',
          subtasks: [],
          createdAt: 10,
          updatedAt: 10
        },
        {
          id: 'g-2',
          title: 'Goal 2',
          status: 'pending',
          subtasks: [],
          createdAt: 20,
          updatedAt: 20
        }
      ]
    }

    const stateHolder = { current: initialData }
    mockService.updateGoals.mockImplementation(async (updater) => {
      stateHolder.current = await updater(stateHolder.current)
      return stateHolder.current
    })

    const deleteHandler = handlers.get(GOALS_IPC_CHANNELS.DELETE_GOAL)
    await deleteHandler!(null, { workspacePath: '/mock/workspace', goalId: 'g-1' })

    expect(stateHolder.current.goals).toHaveLength(1)
    expect(stateHolder.current.goals[0].id).toBe('g-2')
    expect(stateHolder.current.activeGoalId).toBe('g-2')
  })

  it('throws descriptive errors on missing required fields', async () => {
    registerGoalsIpcHandlers(fakeIpcMain, mockManager, mockRunner, broadcastEvent)

    const getHandler = handlers.get(GOALS_IPC_CHANNELS.GET)
    await expect(getHandler!(null, { workspacePath: '' })).rejects.toThrow(
      'Workspace path is required'
    )

    const createHandler = handlers.get(GOALS_IPC_CHANNELS.CREATE_GOAL)
    await expect(
      createHandler!(null, { workspacePath: '/mock/workspace', title: '   ' })
    ).rejects.toThrow('Goal title is required')

    const validationHandler = handlers.get(GOALS_IPC_CHANNELS.RUN_VALIDATION)
    mockService.loadGoals.mockResolvedValue({ activeGoalId: null, goals: [] })
    await expect(validationHandler!(null, { workspacePath: '/mock/workspace' })).rejects.toThrow(
      'No active goal to validate'
    )
  })

  it('unregisters handlers and subscriptions when disposed', () => {
    const unregister = registerGoalsIpcHandlers(
      fakeIpcMain,
      mockManager,
      mockRunner,
      broadcastEvent
    )

    unregister()

    expect(fakeIpcMain.removeHandler).toHaveBeenCalledWith(GOALS_IPC_CHANNELS.GET)
    expect(fakeIpcMain.removeHandler).toHaveBeenCalledWith(GOALS_IPC_CHANNELS.CREATE_GOAL)
    expect(fakeIpcMain.removeHandler).toHaveBeenCalledWith(GOALS_IPC_CHANNELS.SET_ACTIVE)
    expect(fakeIpcMain.removeHandler).toHaveBeenCalledWith(GOALS_IPC_CHANNELS.TOGGLE_SUBTASK)
    expect(fakeIpcMain.removeHandler).toHaveBeenCalledWith(GOALS_IPC_CHANNELS.UPDATE_GOAL)
    expect(fakeIpcMain.removeHandler).toHaveBeenCalledWith(GOALS_IPC_CHANNELS.DELETE_GOAL)
    expect(fakeIpcMain.removeHandler).toHaveBeenCalledWith(GOALS_IPC_CHANNELS.RUN_VALIDATION)
  })
})
