import { ipcMain } from 'electron'
import { registerGoalsIpcHandlers } from '../goals/goals-ipc-handlers'
import { worktreeGoalsManager } from '../goals/worktree-goals-manager'
import { GoalsValidationRunner } from '../goals/goals-validation-runner'

export function registerGoalsHandlers(): () => void {
  const runner = new GoalsValidationRunner()
  return registerGoalsIpcHandlers(ipcMain, worktreeGoalsManager, runner)
}
