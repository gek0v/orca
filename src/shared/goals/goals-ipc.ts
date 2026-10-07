import type { Goal, GoalValidation, WorkspaceGoalsData } from './goals-schema'

export const GOALS_IPC_CHANNELS = {
  GET: 'goals:get',
  CREATE_GOAL: 'goals:create-goal',
  SET_ACTIVE: 'goals:set-active',
  TOGGLE_SUBTASK: 'goals:toggle-subtask',
  UPDATE_GOAL: 'goals:update-goal',
  RUN_VALIDATION: 'goals:run-validation',
  CHANGED: 'goals:changed'
} as const

export type GoalsIpcChannel = (typeof GOALS_IPC_CHANNELS)[keyof typeof GOALS_IPC_CHANNELS]

export type GoalsGetRequest = {
  workspacePath: string
}
export type GoalsGetResponse = WorkspaceGoalsData

export type GoalsCreateGoalRequest = {
  workspacePath: string
  title: string
  description?: string
  subtasks?: string[]
  validationCommand?: string
}
export type GoalsCreateGoalResponse = Goal

export type GoalsSetActiveRequest = {
  workspacePath: string
  goalId: string | null
}
export type GoalsSetActiveResponse = void

export type GoalsToggleSubtaskRequest = {
  workspacePath: string
  goalId: string
  subtaskId: string
  completed: boolean
}
export type GoalsToggleSubtaskResponse = void

export type GoalsUpdateGoalRequest = {
  workspacePath: string
  goalId: string
  updates: Partial<Goal>
}
export type GoalsUpdateGoalResponse = void

export type GoalsRunValidationRequest = {
  workspacePath: string
  goalId?: string
}
export type GoalsRunValidationResponse = GoalValidation

export type GoalsChangedEvent = {
  workspacePath: string
  data: WorkspaceGoalsData
}

export type GoalsIpcInvokeMap = {
  [GOALS_IPC_CHANNELS.GET]: {
    request: GoalsGetRequest
    response: GoalsGetResponse
  }
  [GOALS_IPC_CHANNELS.CREATE_GOAL]: {
    request: GoalsCreateGoalRequest
    response: GoalsCreateGoalResponse
  }
  [GOALS_IPC_CHANNELS.SET_ACTIVE]: {
    request: GoalsSetActiveRequest
    response: GoalsSetActiveResponse
  }
  [GOALS_IPC_CHANNELS.TOGGLE_SUBTASK]: {
    request: GoalsToggleSubtaskRequest
    response: GoalsToggleSubtaskResponse
  }
  [GOALS_IPC_CHANNELS.UPDATE_GOAL]: {
    request: GoalsUpdateGoalRequest
    response: GoalsUpdateGoalResponse
  }
  [GOALS_IPC_CHANNELS.RUN_VALIDATION]: {
    request: GoalsRunValidationRequest
    response: GoalsRunValidationResponse
  }
}
