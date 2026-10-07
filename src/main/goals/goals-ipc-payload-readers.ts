import { GoalSchema, type Goal } from '../../shared/goals/goals-schema'

const PartialGoalSchema = GoalSchema.partial()

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function parseWorkspacePath(firstArg: unknown): string {
  if (typeof firstArg === 'string' && firstArg.trim().length > 0) {
    return firstArg.trim()
  }
  if (
    isRecord(firstArg) &&
    typeof firstArg.workspacePath === 'string' &&
    firstArg.workspacePath.trim().length > 0
  ) {
    return firstArg.workspacePath.trim()
  }
  throw new Error('Workspace path is required')
}

export function parseCreateGoalArgs(
  firstArg: unknown,
  secondArg: unknown
): {
  workspacePath: string
  title: string
  description?: string
  subtasks?: string[]
  validationCommand?: string
} {
  if (typeof firstArg === 'string') {
    const workspacePath = firstArg.trim()
    const options = isRecord(secondArg) ? secondArg : {}
    const title = typeof options.title === 'string' ? options.title.trim() : ''
    const description =
      typeof options.description === 'string' ? options.description.trim() : undefined
    const subtasks = Array.isArray(options.subtasks)
      ? options.subtasks.filter((t): t is string => typeof t === 'string')
      : undefined
    const validationCommand =
      typeof options.validationCommand === 'string' ? options.validationCommand.trim() : undefined
    return { workspacePath, title, description, subtasks, validationCommand }
  }

  if (isRecord(firstArg)) {
    const workspacePath =
      typeof firstArg.workspacePath === 'string' ? firstArg.workspacePath.trim() : ''
    const title = typeof firstArg.title === 'string' ? firstArg.title.trim() : ''
    const description =
      typeof firstArg.description === 'string' ? firstArg.description.trim() : undefined
    const subtasks = Array.isArray(firstArg.subtasks)
      ? firstArg.subtasks.filter((t): t is string => typeof t === 'string')
      : undefined
    const validationCommand =
      typeof optionsValidation(firstArg.validationCommand) === 'string'
        ? optionsValidation(firstArg.validationCommand)
        : undefined
    return { workspacePath, title, description, subtasks, validationCommand }
  }

  throw new Error('Invalid arguments for create-goal')
}

function optionsValidation(val: unknown): string | undefined {
  return typeof val === 'string' ? val.trim() : undefined
}

export function parseSetActiveArgs(
  firstArg: unknown,
  secondArg: unknown
): {
  workspacePath: string
  goalId: string | null
} {
  if (typeof firstArg === 'string') {
    const goalId = typeof secondArg === 'string' ? secondArg : null
    return { workspacePath: firstArg.trim(), goalId }
  }
  if (isRecord(firstArg)) {
    const workspacePath =
      typeof firstArg.workspacePath === 'string' ? firstArg.workspacePath.trim() : ''
    const goalId = typeof firstArg.goalId === 'string' ? firstArg.goalId : null
    return { workspacePath, goalId }
  }
  throw new Error('Invalid arguments for set-active')
}

export function parseToggleSubtaskArgs(
  firstArg: unknown,
  secondArg: unknown,
  thirdArg: unknown,
  fourthArg: unknown
): {
  workspacePath: string
  goalId: string
  subtaskId: string
  completed: boolean
} {
  if (typeof firstArg === 'string') {
    return {
      workspacePath: firstArg.trim(),
      goalId: typeof secondArg === 'string' ? secondArg : '',
      subtaskId: typeof thirdArg === 'string' ? thirdArg : '',
      completed: Boolean(fourthArg)
    }
  }
  if (isRecord(firstArg)) {
    return {
      workspacePath:
        typeof firstArg.workspacePath === 'string' ? firstArg.workspacePath.trim() : '',
      goalId: typeof firstArg.goalId === 'string' ? firstArg.goalId : '',
      subtaskId: typeof firstArg.subtaskId === 'string' ? firstArg.subtaskId : '',
      completed: Boolean(firstArg.completed)
    }
  }
  throw new Error('Invalid arguments for toggle-subtask')
}

export function parseUpdateGoalArgs(
  firstArg: unknown,
  secondArg: unknown,
  thirdArg: unknown
): {
  workspacePath: string
  goalId: string
  updates: Partial<Goal>
} {
  if (typeof firstArg === 'string') {
    const rawUpdates = isRecord(thirdArg) ? thirdArg : {}
    return {
      workspacePath: firstArg.trim(),
      goalId: typeof secondArg === 'string' ? secondArg : '',
      updates: PartialGoalSchema.parse(rawUpdates)
    }
  }
  if (isRecord(firstArg)) {
    const rawUpdates = isRecord(firstArg.updates) ? firstArg.updates : {}
    return {
      workspacePath:
        typeof firstArg.workspacePath === 'string' ? firstArg.workspacePath.trim() : '',
      goalId: typeof firstArg.goalId === 'string' ? firstArg.goalId : '',
      updates: PartialGoalSchema.parse(rawUpdates)
    }
  }
  throw new Error('Invalid arguments for update-goal')
}

export function parseRunValidationArgs(
  firstArg: unknown,
  secondArg: unknown
): {
  workspacePath: string
  goalId?: string
} {
  if (typeof firstArg === 'string') {
    return {
      workspacePath: firstArg.trim(),
      goalId: typeof secondArg === 'string' ? secondArg : undefined
    }
  }
  if (isRecord(firstArg)) {
    return {
      workspacePath:
        typeof firstArg.workspacePath === 'string' ? firstArg.workspacePath.trim() : '',
      goalId: typeof firstArg.goalId === 'string' ? firstArg.goalId : undefined
    }
  }
  throw new Error('Invalid arguments for run-validation')
}
