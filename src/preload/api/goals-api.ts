import type {
  GoalsChangedEvent,
  GoalsCreateGoalRequest,
  GoalsCreateGoalResponse,
  GoalsGetRequest,
  GoalsGetResponse,
  GoalsRunValidationRequest,
  GoalsRunValidationResponse,
  GoalsSetActiveRequest,
  GoalsSetActiveResponse,
  GoalsToggleSubtaskRequest,
  GoalsToggleSubtaskResponse,
  GoalsUpdateGoalRequest,
  GoalsUpdateGoalResponse
} from '../../shared/goals/goals-ipc'

export type GoalsApi = {
  get: (args: GoalsGetRequest) => Promise<GoalsGetResponse>
  createGoal: (args: GoalsCreateGoalRequest) => Promise<GoalsCreateGoalResponse>
  setActive: (args: GoalsSetActiveRequest) => Promise<GoalsSetActiveResponse>
  toggleSubtask: (args: GoalsToggleSubtaskRequest) => Promise<GoalsToggleSubtaskResponse>
  updateGoal: (args: GoalsUpdateGoalRequest) => Promise<GoalsUpdateGoalResponse>
  runValidation: (args: GoalsRunValidationRequest) => Promise<GoalsRunValidationResponse>
  onChanged: (callback: (event: GoalsChangedEvent) => void) => () => void
}
