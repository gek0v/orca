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
  parseRunValidationArgs
} from './goals-ipc-payload-readers'

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
        const now = Date.now()
        let createdGoal: Goal | null = null

        await service.updateGoals((current) => {
          const willBeActive = !current.activeGoalId
          const id = `goal-${now}${current.goals.some((g) => g.id === `goal-${now}`) ? `-${current.goals.length + 1}` : ''}`
          const goal: Goal = {
            id,
            title: req.title,
            description: req.description,
            status: willBeActive ? 'in_progress' : 'pending',
            subtasks: (req.subtasks ?? []).map((title, idx) => ({
              id: `task-${now}-${idx + 1}`,
              title,
              completed: false
            })),
            validation: req.validationCommand
              ? {
                  command: req.validationCommand,
                  status: 'idle'
                }
              : undefined,
            createdAt: now,
            updatedAt: now
          }

          createdGoal = goal
          return {
            activeGoalId: willBeActive ? id : current.activeGoalId,
            goals: [...current.goals, goal]
          }
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
        await service.updateGoals((current) => {
          if (req.goalId !== null && !current.goals.some((g) => g.id === req.goalId)) {
            throw new Error(`Goal with id "${req.goalId}" not found`)
          }
          return {
            ...current,
            activeGoalId: req.goalId
          }
        })
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
        await service.updateGoals((current) => {
          const goalIndex = current.goals.findIndex((g) => g.id === req.goalId)
          if (goalIndex === -1) {
            throw new Error(`Goal with id "${req.goalId}" not found`)
          }

          const goal = current.goals[goalIndex]
          const subtaskIndex = goal.subtasks.findIndex((st) => st.id === req.subtaskId)
          if (subtaskIndex === -1) {
            throw new Error(`Subtask with id "${req.subtaskId}" not found in goal "${req.goalId}"`)
          }

          const updatedSubtasks = goal.subtasks.map((st, idx) =>
            idx === subtaskIndex ? { ...st, completed: req.completed } : st
          )

          const allCompleted =
            updatedSubtasks.length > 0 && updatedSubtasks.every((st) => st.completed)
          let nextStatus = goal.status
          if (allCompleted) {
            nextStatus = 'completed'
          } else if (goal.status === 'completed' && !allCompleted) {
            nextStatus = 'in_progress'
          }

          const updatedGoal: Goal = {
            ...goal,
            subtasks: updatedSubtasks,
            status: nextStatus,
            updatedAt: Date.now()
          }

          const updatedGoals = [...current.goals]
          updatedGoals[goalIndex] = updatedGoal
          return {
            ...current,
            goals: updatedGoals
          }
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[goals-ipc] Error in ${GOALS_IPC_CHANNELS.TOGGLE_SUBTASK}: ${message}`)
        throw error instanceof Error ? error : new Error(message)
      }
    }
  )

  ipcMain.handle(
    GOALS_IPC_CHANNELS.UPDATE_GOAL,
    async (_event: unknown, ...args: unknown[]): Promise<void> => {
      try {
        const req = parseUpdateGoalArgs(args[0], args[1], args[2])
        if (!req.workspacePath || !req.goalId) {
          throw new Error('workspacePath and goalId are required')
        }

        const service = resolveService(req.workspacePath)
        await service.updateGoals((current) => {
          const goalIndex = current.goals.findIndex((g) => g.id === req.goalId)
          if (goalIndex === -1) {
            throw new Error(`Goal with id "${req.goalId}" not found`)
          }

          const target = current.goals[goalIndex]
          const updatedGoal: Goal = {
            ...target,
            ...req.updates,
            id: target.id,
            createdAt: target.createdAt,
            updatedAt: Date.now()
          }

          const updatedGoals = [...current.goals]
          updatedGoals[goalIndex] = updatedGoal
          return {
            ...current,
            goals: updatedGoals
          }
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[goals-ipc] Error in ${GOALS_IPC_CHANNELS.UPDATE_GOAL}: ${message}`)
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

        const targetGoal = currentData.goals.find((g) => g.id === targetGoalId)
        if (!targetGoal) {
          throw new Error(`Goal with id "${targetGoalId}" not found`)
        }
        if (!targetGoal.validation?.command) {
          throw new Error(`Goal "${targetGoalId}" has no validation command configured`)
        }

        const command = targetGoal.validation.command
        const result = await runner.runValidation(req.workspacePath, command, targetGoalId)

        await service.updateGoals((current) => {
          const idx = current.goals.findIndex((g) => g.id === targetGoalId)
          if (idx === -1) {
            return current
          }
          const goal = current.goals[idx]
          const updatedGoal: Goal = {
            ...goal,
            validation: result,
            updatedAt: Date.now()
          }
          const updatedGoals = [...current.goals]
          updatedGoals[idx] = updatedGoal
          return {
            ...current,
            goals: updatedGoals
          }
        })

        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[goals-ipc] Error in ${GOALS_IPC_CHANNELS.RUN_VALIDATION}: ${message}`)
        throw error instanceof Error ? error : new Error(message)
      }
    }
  )

  return () => {
    for (const unsub of unwatchers.values()) {
      unsub()
    }
    unwatchers.clear()
    ipcMain.removeHandler(GOALS_IPC_CHANNELS.GET)
    ipcMain.removeHandler(GOALS_IPC_CHANNELS.CREATE_GOAL)
    ipcMain.removeHandler(GOALS_IPC_CHANNELS.SET_ACTIVE)
    ipcMain.removeHandler(GOALS_IPC_CHANNELS.TOGGLE_SUBTASK)
    ipcMain.removeHandler(GOALS_IPC_CHANNELS.UPDATE_GOAL)
    ipcMain.removeHandler(GOALS_IPC_CHANNELS.RUN_VALIDATION)
  }
}
