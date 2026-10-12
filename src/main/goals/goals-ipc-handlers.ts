import * as electronModule from 'electron'
import type { IpcMain } from 'electron'
import { GOALS_IPC_CHANNELS, type GoalsChangedEvent } from '../../shared/goals/goals-ipc'
import type { Goal, WorkspaceGoalsData } from '../../shared/goals/goals-schema'
import type { WorktreeGoalsManager } from './worktree-goals-manager'
import type { WorktreeGoalsService } from './worktree-goals-service'
import type { GoalsValidationRunner, GoalValidationResult } from './goals-validation-runner'
import {
  parseWorkspacePath,
  parseCreateGoalArgs,
  parseSetActiveArgs,
  parseToggleSubtaskArgs,
  parseUpdateGoalArgs,
  parseRunValidationArgs,
  parseDeleteGoalArgs
} from './goals-ipc-payload-readers'
import {
  applyCreateGoal,
  applySetActiveGoal,
  applyToggleSubtask,
  applyUpdateGoal,
  applyDeleteGoal,
  applyValidationResult
} from './goals-state-transitions'
import { registerGoalsAiAndWorkerIpcHandlers } from './goals-ai-worker-ipc-handlers'

export type GoalsIpcTarget = Pick<IpcMain, 'handle' | 'removeHandler'>
export type GoalsManagerTarget = Pick<WorktreeGoalsManager, 'getService'>
export type GoalsRunnerTarget = Pick<GoalsValidationRunner, 'runValidation'>

function broadcastToAllWindows(channel: string, payload: unknown): void {
  const browserWindow = electronModule.BrowserWindow
  if (typeof browserWindow?.getAllWindows === 'function') {
    for (const win of browserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload)
      }
    }
  }
}

export function registerGoalsIpcHandlers(
  ipcMain: GoalsIpcTarget,
  manager: GoalsManagerTarget,
  runner: GoalsRunnerTarget,
  broadcastEvent?: (channel: string, payload: unknown) => void
): () => void {
  const unregisterAiWorker = registerGoalsAiAndWorkerIpcHandlers(ipcMain, manager)
  const unwatchers = new Map<string, () => void>()

  const broadcast = (channel: string, payload: unknown): void => {
    if (broadcastEvent) {
      broadcastEvent(channel, payload)
    } else {
      broadcastToAllWindows(channel, payload)
    }
  }

  const resolveService = (workspacePath: string): WorktreeGoalsService => {
    const service = manager.getService(workspacePath)
    if (!unwatchers.has(service.workspacePath)) {
      const unsub = service.onExternalChange((data: WorkspaceGoalsData) => {
        const eventPayload: GoalsChangedEvent = {
          workspacePath: service.workspacePath,
          data
        }
        broadcast(GOALS_IPC_CHANNELS.CHANGED, eventPayload)
      })
      unwatchers.set(service.workspacePath, unsub)
    }
    return service
  }

  ipcMain.handle(
    GOALS_IPC_CHANNELS.GET,
    async (_event: unknown, ...args: unknown[]): Promise<WorkspaceGoalsData> => {
      try {
        const workspacePath = parseWorkspacePath(args[0])
        const service = resolveService(workspacePath)
        return await service.loadGoals()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[goals-ipc] Error in ${GOALS_IPC_CHANNELS.GET}: ${message}`)
        throw error instanceof Error ? error : new Error(message)
      }
    }
  )

  ipcMain.handle(
    GOALS_IPC_CHANNELS.CREATE_GOAL,
    async (_event: unknown, ...args: unknown[]): Promise<Goal> => {
      try {
        const req = parseCreateGoalArgs(args[0], args[1])
        if (!req.workspacePath) {
          throw new Error('Workspace path is required')
        }
        if (!req.title) {
          throw new Error('Goal title is required')
        }

        const service = resolveService(req.workspacePath)
        let createdGoal: Goal | null = null

        await service.updateGoals((current) => {
          const result = applyCreateGoal(current, req)
          createdGoal = result.created
          return result.next
        })

        if (!createdGoal) {
          throw new Error('Failed to create goal')
        }
        return createdGoal
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[goals-ipc] Error in ${GOALS_IPC_CHANNELS.CREATE_GOAL}: ${message}`)
        throw error instanceof Error ? error : new Error(message)
      }
    }
  )

  ipcMain.handle(
    GOALS_IPC_CHANNELS.SET_ACTIVE,
    async (_event: unknown, ...args: unknown[]): Promise<void> => {
      try {
        const req = parseSetActiveArgs(args[0], args[1])
        if (!req.workspacePath) {
          throw new Error('Workspace path is required')
        }

        const service = resolveService(req.workspacePath)
        await service.updateGoals((current) => applySetActiveGoal(current, req.goalId))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[goals-ipc] Error in ${GOALS_IPC_CHANNELS.SET_ACTIVE}: ${message}`)
        throw error instanceof Error ? error : new Error(message)
      }
    }
  )

  ipcMain.handle(
    GOALS_IPC_CHANNELS.TOGGLE_SUBTASK,
    async (_event: unknown, ...args: unknown[]): Promise<void> => {
      try {
        const req = parseToggleSubtaskArgs(args[0], args[1], args[2], args[3])
        if (!req.workspacePath || !req.goalId || !req.subtaskId) {
          throw new Error('workspacePath, goalId, and subtaskId are required')
        }

        const service = resolveService(req.workspacePath)
        await service.updateGoals((current) =>
          applyToggleSubtask(current, req.goalId, req.subtaskId, req.completed)
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[goals-ipc] Error in ${GOALS_IPC_CHANNELS.TOGGLE_SUBTASK}: ${message}`)
        throw error instanceof Error ? error : new Error(message)
      }
    }
  )

  ipcMain.handle(
    GOALS_IPC_CHANNELS.UPDATE_GOAL,
    async (_event: unknown, ...args: unknown[]): Promise<Goal> => {
      try {
        const req = parseUpdateGoalArgs(args[0], args[1], args[2])
        if (!req.workspacePath || !req.goalId) {
          throw new Error('workspacePath and goalId are required')
        }

        const service = resolveService(req.workspacePath)
        let updatedGoal: Goal | null = null

        await service.updateGoals((current) => {
          const result = applyUpdateGoal(current, req.goalId, req.updates)
          updatedGoal = result.updated
          return result.next
        })

        if (!updatedGoal) {
          throw new Error('Failed to update goal')
        }
        return updatedGoal
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[goals-ipc] Error in ${GOALS_IPC_CHANNELS.UPDATE_GOAL}: ${message}`)
        throw error instanceof Error ? error : new Error(message)
      }
    }
  )

  ipcMain.handle(
    GOALS_IPC_CHANNELS.DELETE_GOAL,
    async (_event: unknown, ...args: unknown[]): Promise<void> => {
      try {
        const req = parseDeleteGoalArgs(args[0], args[1])
        if (!req.workspacePath || !req.goalId) {
          throw new Error('workspacePath and goalId are required')
        }

        const service = resolveService(req.workspacePath)
        await service.updateGoals((current) => applyDeleteGoal(current, req.goalId))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[goals-ipc] Error in ${GOALS_IPC_CHANNELS.DELETE_GOAL}: ${message}`)
        throw error instanceof Error ? error : new Error(message)
      }
    }
  )

  ipcMain.handle(
    GOALS_IPC_CHANNELS.RUN_VALIDATION,
    async (_event: unknown, ...args: unknown[]): Promise<GoalValidationResult> => {
      try {
        const req = parseRunValidationArgs(args[0], args[1])
        if (!req.workspacePath) {
          throw new Error('Workspace path is required')
        }

        const service = resolveService(req.workspacePath)
        const currentData = await service.loadGoals()
        const targetGoalId = req.goalId ?? currentData.activeGoalId
        if (!targetGoalId) {
          throw new Error('No active goal to validate')
        }

        const goal = currentData.goals.find((g) => g.id === targetGoalId)
        if (!goal) {
          throw new Error(`Goal with id "${targetGoalId}" not found`)
        }
        if (!goal.validation?.command) {
          throw new Error(`Goal "${goal.title}" has no validation command configured`)
        }

        const command = goal.validation.command
        const result = await runner.runValidation(req.workspacePath, command, targetGoalId)
        await service.updateGoals((current) => applyValidationResult(current, targetGoalId, result))
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[goals-ipc] Error in ${GOALS_IPC_CHANNELS.RUN_VALIDATION}: ${message}`)
        throw error instanceof Error ? error : new Error(message)
      }
    }
  )

  return () => {
    unregisterAiWorker()
    for (const unsub of unwatchers.values()) {
      unsub()
    }
    unwatchers.clear()
    ipcMain.removeHandler(GOALS_IPC_CHANNELS.GET)
    ipcMain.removeHandler(GOALS_IPC_CHANNELS.CREATE_GOAL)
    ipcMain.removeHandler(GOALS_IPC_CHANNELS.SET_ACTIVE)
    ipcMain.removeHandler(GOALS_IPC_CHANNELS.TOGGLE_SUBTASK)
    ipcMain.removeHandler(GOALS_IPC_CHANNELS.UPDATE_GOAL)
    ipcMain.removeHandler(GOALS_IPC_CHANNELS.DELETE_GOAL)
    ipcMain.removeHandler(GOALS_IPC_CHANNELS.RUN_VALIDATION)
  }
}
