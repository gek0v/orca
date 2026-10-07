import path from 'node:path'
import type { HandlerContext } from './dispatch'
import { RuntimeClientError } from './runtime/types'
import { worktreeGoalsManager } from '../main/goals/worktree-goals-manager'
import { GoalsValidationRunner } from '../main/goals/goals-validation-runner'
import { applyCreateGoal } from '../main/goals/goals-state-transitions'
import type { Goal, GoalSubtask } from '../shared/goals/goals-schema'

export function resolveTargetWorkspacePath(ctx: HandlerContext): string {
  const worktreeFlag = ctx.flags.get('worktree')
  if (typeof worktreeFlag === 'string' && worktreeFlag.trim().length > 0) {
    return path.resolve(ctx.cwd, worktreeFlag)
  }
  if (process.env.ORCA_CLI_CWD && process.env.ORCA_CLI_CWD.trim().length > 0) {
    return path.resolve(process.env.ORCA_CLI_CWD)
  }
  return path.resolve(ctx.cwd)
}

export async function dispatchGoal(commandPath: string[], ctx: HandlerContext): Promise<void> {
  const subcommand = commandPath[1] ?? 'status'

  switch (subcommand) {
    case 'status':
      await handleStatus(ctx)
      break
    case 'set':
    case 'create':
      await handleSet(ctx)
      break
    case 'complete':
      await handleComplete(ctx)
      break
    case 'validate':
      await handleValidate(ctx)
      break
    case 'add-task':
      await handleAddTask(ctx)
      break
    default:
      throw new RuntimeClientError('invalid_argument', `Unknown goal subcommand: ${subcommand}`)
  }
}

async function handleStatus(ctx: HandlerContext): Promise<void> {
  const workspacePath = resolveTargetWorkspacePath(ctx)
  const service = worktreeGoalsManager.getService(workspacePath)
  const goalsData = await service.loadGoals()
  const activeGoal = goalsData.activeGoalId
    ? (goalsData.goals.find((g) => g.id === goalsData.activeGoalId) ?? null)
    : null

  if (ctx.json) {
    console.log(
      JSON.stringify(
        {
          activeGoalId: goalsData.activeGoalId,
          activeGoal,
          goals: goalsData.goals
        },
        null,
        2
      )
    )
    return
  }

  if (!activeGoal) {
    console.log(`No active goal found in ${workspacePath}.`)
    return
  }

  const lines: string[] = [`Goal: ${activeGoal.title} [${activeGoal.status}]`]
  if (activeGoal.description) {
    lines.push(`Description: ${activeGoal.description}`)
  }
  lines.push('Subtasks:')
  if (activeGoal.subtasks.length === 0) {
    lines.push('  (No subtasks)')
  } else {
    activeGoal.subtasks.forEach((task, idx) => {
      const mark = task.completed ? '[x]' : '[ ]'
      lines.push(`  ${mark} ${idx + 1}. ${task.title} (id: ${task.id})`)
    })
  }
  if (activeGoal.validation) {
    const v = activeGoal.validation
    lines.push(`Validation: ${v.status} (command: ${v.command})`)
    if (v.exitCode !== undefined) {
      lines.push(`  Exit code: ${v.exitCode}`)
    }
    if (v.summaryTail) {
      lines.push(`  Summary:\n${v.summaryTail}`)
    }
  }

  console.log(lines.join('\n'))
}

async function handleSet(ctx: HandlerContext): Promise<void> {
  const title = ctx.flags.get('title')
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new RuntimeClientError('invalid_argument', 'Goal title cannot be empty.')
  }

  const descriptionFlag = ctx.flags.get('description')
  const description =
    typeof descriptionFlag === 'string' && descriptionFlag.trim().length > 0
      ? descriptionFlag.trim()
      : undefined

  const validationFlag = ctx.flags.get('validation')
  const validationCommand =
    typeof validationFlag === 'string' && validationFlag.trim().length > 0
      ? validationFlag.trim()
      : undefined

  const workspacePath = resolveTargetWorkspacePath(ctx)
  const service = worktreeGoalsManager.getService(workspacePath)
  let createdGoal: Goal | null = null

  await service.updateGoals((current) => {
    const result = applyCreateGoal(current, {
      workspacePath,
      title: title.trim(),
      description,
      validationCommand
    })
    createdGoal = result.created
    return {
      ...result.next,
      activeGoalId: result.created.id
    }
  })

  if (!createdGoal) {
    throw new RuntimeClientError('internal', 'Failed to create goal.')
  }

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: createdGoal is checked above.
  const goal = createdGoal as Goal

  if (ctx.json) {
    console.log(JSON.stringify({ activeGoalId: goal.id, goal }, null, 2))
    return
  }

  console.log(`Active goal set: "${goal.title}" (id: ${goal.id}).`)
  if (goal.description) {
    console.log(`Description: ${goal.description}`)
  }
  if (goal.validation) {
    console.log(`Validation command: ${goal.validation.command}`)
  }
}

async function handleComplete(ctx: HandlerContext): Promise<void> {
  const idOrIndex = ctx.flags.get('id-or-index')
  if (typeof idOrIndex !== 'string' || idOrIndex.trim().length === 0) {
    throw new RuntimeClientError('invalid_argument', 'Missing subtask ID or index.')
  }

  const workspacePath = resolveTargetWorkspacePath(ctx)
  const service = worktreeGoalsManager.getService(workspacePath)
  const goalsData = await service.loadGoals()
  const activeGoal = goalsData.activeGoalId
    ? (goalsData.goals.find((g) => g.id === goalsData.activeGoalId) ?? null)
    : null

  if (!activeGoal) {
    throw new RuntimeClientError('not_found', 'No active goal found in workspace.')
  }

  const trimmed = idOrIndex.trim()
  let targetTask = activeGoal.subtasks.find((t) => t.id === trimmed)
  if (!targetTask && /^\d+$/.test(trimmed)) {
    const index = Number.parseInt(trimmed, 10) - 1
    if (index >= 0 && index < activeGoal.subtasks.length) {
      targetTask = activeGoal.subtasks[index]
    }
  }

  if (!targetTask) {
    throw new RuntimeClientError('not_found', `Subtask "${trimmed}" not found in active goal.`)
  }

  targetTask.completed = true
  activeGoal.updatedAt = Date.now()

  await service.saveGoals(goalsData)
  await service.projectCurrentGoalFile()

  const remainingCount = activeGoal.subtasks.filter((t) => !t.completed).length

  if (ctx.json) {
    console.log(JSON.stringify({ completedSubtask: targetTask, remainingCount }, null, 2))
    return
  }

  console.log(
    `Completed subtask: "${targetTask.title}" (${targetTask.id}). Remaining tasks: ${remainingCount}.`
  )
}

async function handleValidate(ctx: HandlerContext): Promise<void> {
  const workspacePath = resolveTargetWorkspacePath(ctx)
  const service = worktreeGoalsManager.getService(workspacePath)
  const goalsData = await service.loadGoals()
  const activeGoal = goalsData.activeGoalId
    ? (goalsData.goals.find((g) => g.id === goalsData.activeGoalId) ?? null)
    : null

  if (!activeGoal) {
    throw new RuntimeClientError('not_found', 'No active goal found in workspace.')
  }

  if (!activeGoal.validation?.command) {
    throw new RuntimeClientError(
      'failed_precondition',
      'No validation command configured for active goal.'
    )
  }

  const runner = new GoalsValidationRunner()
  const result = await runner.runValidation(
    workspacePath,
    activeGoal.validation.command,
    activeGoal.id
  )

  activeGoal.validation = {
    ...activeGoal.validation,
    status: result.status,
    exitCode: result.exitCode,
    lastRunAt: result.lastRunAt,
    summaryTail: result.summaryTail
  }
  activeGoal.updatedAt = Date.now()

  await service.saveGoals(goalsData)
  await service.projectCurrentGoalFile()

  if (ctx.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  const outcome = result.status === 'success' ? 'Passed' : 'Failed'
  const lines = [
    `Validation ${outcome} (exit code ${result.exitCode}): ${activeGoal.validation.command}`
  ]
  if (result.summaryTail) {
    lines.push(result.summaryTail)
  }
  console.log(lines.join('\n'))
}

async function handleAddTask(ctx: HandlerContext): Promise<void> {
  const title = ctx.flags.get('title')
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new RuntimeClientError('invalid_argument', 'Subtask title cannot be empty.')
  }

  const workspacePath = resolveTargetWorkspacePath(ctx)
  const service = worktreeGoalsManager.getService(workspacePath)
  const goalsData = await service.loadGoals()
  const activeGoal = goalsData.activeGoalId
    ? (goalsData.goals.find((g) => g.id === goalsData.activeGoalId) ?? null)
    : null

  if (!activeGoal) {
    throw new RuntimeClientError('not_found', 'No active goal found in workspace.')
  }

  const newSubtask: GoalSubtask = {
    id: `task-${Date.now()}`,
    title: title.trim(),
    completed: false
  }

  activeGoal.subtasks.push(newSubtask)
  activeGoal.updatedAt = Date.now()

  await service.saveGoals(goalsData)
  await service.projectCurrentGoalFile()

  if (ctx.json) {
    console.log(JSON.stringify({ subtask: newSubtask }, null, 2))
    return
  }

  console.log(`Added subtask: "${newSubtask.title}" (id: ${newSubtask.id}).`)
}
