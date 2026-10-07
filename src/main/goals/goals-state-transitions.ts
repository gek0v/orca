import type { Goal, WorkspaceGoalsData } from '../../shared/goals/goals-schema'
import type { GoalsCreateGoalRequest, GoalsUpdateGoalRequest } from '../../shared/goals/goals-ipc'
import type { GoalValidationResult } from './goals-validation-runner'

export function applyCreateGoal(
  current: WorkspaceGoalsData,
  req: GoalsCreateGoalRequest,
  now = Date.now()
): { next: WorkspaceGoalsData; created: Goal } {
  const willBeActive = !current.activeGoalId
  const id = `goal-${now}${current.goals.some((g) => g.id === `goal-${now}`) ? `-${current.goals.length + 1}` : ''}`
  const created: Goal = {
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

  return {
    next: {
      activeGoalId: willBeActive ? id : current.activeGoalId,
      goals: [...current.goals, created]
    },
    created
  }
}

export function applySetActiveGoal(
  current: WorkspaceGoalsData,
  goalId: string | null
): WorkspaceGoalsData {
  if (goalId !== null && !current.goals.some((g) => g.id === goalId)) {
    throw new Error(`Goal with id "${goalId}" not found`)
  }
  return {
    ...current,
    activeGoalId: goalId
  }
}

export function applyToggleSubtask(
  current: WorkspaceGoalsData,
  goalId: string,
  subtaskId: string,
  completed: boolean,
  now = Date.now()
): WorkspaceGoalsData {
  const goalIndex = current.goals.findIndex((g) => g.id === goalId)
  if (goalIndex === -1) {
    throw new Error(`Goal with id "${goalId}" not found`)
  }

  const goal = current.goals[goalIndex]
  const subtaskIndex = goal.subtasks.findIndex((st) => st.id === subtaskId)
  if (subtaskIndex === -1) {
    throw new Error(`Subtask with id "${subtaskId}" not found in goal "${goalId}"`)
  }

  const updatedSubtasks = goal.subtasks.map((st, idx) =>
    idx === subtaskIndex ? { ...st, completed } : st
  )

  const allCompleted = updatedSubtasks.length > 0 && updatedSubtasks.every((st) => st.completed)
  let nextStatus = goal.status
  if (allCompleted) {
    nextStatus = 'completed'
  } else if (goal.status === 'completed' && !allCompleted) {
    nextStatus = 'in_progress'
  }

  const updatedGoal: Goal = {
    ...goal,
    status: nextStatus,
    subtasks: updatedSubtasks,
    updatedAt: now
  }

  return {
    ...current,
    goals: current.goals.map((g, idx) => (idx === goalIndex ? updatedGoal : g))
  }
}

export function applyUpdateGoal(
  current: WorkspaceGoalsData,
  goalId: string,
  updates: GoalsUpdateGoalRequest['updates'],
  now = Date.now()
): { next: WorkspaceGoalsData; updated: Goal } {
  const goalIndex = current.goals.findIndex((g) => g.id === goalId)
  if (goalIndex === -1) {
    throw new Error(`Goal with id "${goalId}" not found`)
  }

  const goal = current.goals[goalIndex]
  const updated: Goal = {
    ...goal,
    ...updates,
    id: goal.id,
    createdAt: goal.createdAt,
    updatedAt: now
  }

  return {
    next: {
      ...current,
      goals: current.goals.map((g, idx) => (idx === goalIndex ? updated : g))
    },
    updated
  }
}

export function applyDeleteGoal(current: WorkspaceGoalsData, goalId: string): WorkspaceGoalsData {
  const exists = current.goals.some((g) => g.id === goalId)
  if (!exists) {
    throw new Error(`Goal with id "${goalId}" not found`)
  }

  const remainingGoals = current.goals.filter((g) => g.id !== goalId)
  const nextActiveId =
    current.activeGoalId === goalId ? (remainingGoals[0]?.id ?? null) : current.activeGoalId

  return {
    activeGoalId: nextActiveId,
    goals: remainingGoals
  }
}

export function applyValidationResult(
  current: WorkspaceGoalsData,
  goalId: string,
  result: GoalValidationResult,
  now = Date.now()
): WorkspaceGoalsData {
  const idx = current.goals.findIndex((g) => g.id === goalId)
  if (idx === -1) {
    return current
  }
  const goal = current.goals[idx]
  const updatedGoal: Goal = {
    ...goal,
    validation: result,
    updatedAt: now
  }
  return {
    ...current,
    goals: current.goals.map((g, i) => (i === idx ? updatedGoal : g))
  }
}
