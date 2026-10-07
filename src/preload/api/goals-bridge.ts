import { ipcRenderer } from 'electron'
import {
  GOALS_IPC_CHANNELS,
  type GoalsChangedEvent,
  type GoalsCreateGoalRequest,
  type GoalsGetRequest,
  type GoalsRunValidationRequest,
  type GoalsSetActiveRequest,
  type GoalsToggleSubtaskRequest,
  type GoalsUpdateGoalRequest
} from '../../shared/goals/goals-ipc'
import type { GoalsApi } from './goals-api'

export const goalsApi = {
  get: (args: GoalsGetRequest) => ipcRenderer.invoke(GOALS_IPC_CHANNELS.GET, args),
  createGoal: (args: GoalsCreateGoalRequest) =>
    ipcRenderer.invoke(GOALS_IPC_CHANNELS.CREATE_GOAL, args),
  setActive: (args: GoalsSetActiveRequest) =>
    ipcRenderer.invoke(GOALS_IPC_CHANNELS.SET_ACTIVE, args),
  toggleSubtask: (args: GoalsToggleSubtaskRequest) =>
    ipcRenderer.invoke(GOALS_IPC_CHANNELS.TOGGLE_SUBTASK, args),
  updateGoal: (args: GoalsUpdateGoalRequest) =>
    ipcRenderer.invoke(GOALS_IPC_CHANNELS.UPDATE_GOAL, args),
  runValidation: (args: GoalsRunValidationRequest) =>
    ipcRenderer.invoke(GOALS_IPC_CHANNELS.RUN_VALIDATION, args),
  onChanged: (callback: (event: GoalsChangedEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: GoalsChangedEvent) => callback(data)
    ipcRenderer.on(GOALS_IPC_CHANNELS.CHANGED, listener)
    return () => ipcRenderer.removeListener(GOALS_IPC_CHANNELS.CHANGED, listener)
  }
} satisfies GoalsApi
