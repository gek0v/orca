import type { HandlerContext } from './dispatch'
import { RuntimeClientError } from './runtime/types'
import { worktreeGoalsManager } from '../main/goals/worktree-goals-manager'
import { applyAssignWorker, applyUpdateWorkerStatus } from '../main/goals/goals-state-transitions'
import type { GoalSubtaskWorker } from '../shared/goals/goals-schema'
import { resolveTargetWorkspacePath } from './goals-dispatch'

export async function handleAssignWorker(ctx: HandlerContext): Promise<void> {
  const idOrIndex = ctx.flags.get('id-or-index')
  if (typeof idOrIndex !== 'string' || idOrIndex.trim().length === 0) {
    throw new RuntimeClientError('invalid_argument', 'Missing subtask ID or index.')
  }

  const agent = ctx.flags.get('agent')
  if (typeof agent !== 'string' || agent.trim().length === 0) {
    throw new RuntimeClientError('invalid_argument', 'Missing worker agent (--agent <name>).')
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

  const statusFlag = ctx.flags.get('status')
  const status: GoalSubtaskWorker['status'] =
    statusFlag === 'idle' ||
    statusFlag === 'starting' ||
    statusFlag === 'running' ||
    statusFlag === 'completed' ||
    statusFlag === 'failed'
      ? statusFlag
      : 'running'

  const dispatchIdFlag = ctx.flags.get('dispatch-id')
  const dispatchId =
    typeof dispatchIdFlag === 'string' && dispatchIdFlag.trim().length > 0
      ? dispatchIdFlag.trim()
      : undefined

  const worker: GoalSubtaskWorker = {
    workerId: targetTask.worker?.workerId ?? `worker-${Date.now()}`,
    agent: agent.trim(),
    dispatchId,
    status,
    assignedAt: targetTask.worker?.assignedAt ?? Date.now()
  }

  await service.updateGoals((current) => {
    const assigned = applyAssignWorker(current, activeGoal.id, targetTask.id, worker)
    return status === 'completed'
      ? applyUpdateWorkerStatus(assigned, activeGoal.id, targetTask.id, 'completed')
      : assigned
  })

  if (ctx.json) {
    console.log(JSON.stringify({ subtaskId: targetTask.id, worker }, null, 2))
    return
  }

  console.log(
    `Worker "${worker.agent}" [${worker.status}] updated for subtask: "${targetTask.title}" (${targetTask.id}).`
  )
}
