import { useCallback, useEffect, useState } from 'react'
import type {
  Goal,
  GoalValidation,
  WorkspaceGoalsData
} from '../../../../shared/goals/goals-schema'

export function useWorkspaceGoals(workspacePath: string | null | undefined) {
  const [data, setData] = useState<WorkspaceGoalsData | null>(null)
  const [isLoading, setIsLoading] = useState<boolean>(Boolean(workspacePath))
  const [error, setError] = useState<Error | null>(null)

  const refresh = useCallback(async () => {
    if (!workspacePath || !window.api?.goals?.get) {
      setData(null)
      setIsLoading(false)
      return
    }
    try {
      setIsLoading(true)
      const result = await window.api.goals.get({ workspacePath })
      setData(result)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setIsLoading(false)
    }
  }, [workspacePath])

  useEffect(() => {
    void refresh()

    if (!workspacePath || !window.api?.goals?.onChanged) {
      return
    }

    const unsubscribe = window.api.goals.onChanged((event) => {
      if (event.workspacePath === workspacePath) {
        setData(event.data)
      }
    })

    return () => {
      unsubscribe()
    }
  }, [workspacePath, refresh])

  const createGoal = useCallback(
    async (
      title: string,
      options?: { description?: string; subtasks?: string[]; validationCommand?: string }
    ): Promise<Goal | undefined> => {
      if (!workspacePath || !window.api?.goals?.createGoal) {
        return undefined
      }
      const created = await window.api.goals.createGoal({
        workspacePath,
        title,
        ...options
      })
      await refresh()
      return created
    },
    [workspacePath, refresh]
  )

  const setActiveGoal = useCallback(
    async (goalId: string | null): Promise<void> => {
      if (!workspacePath || !window.api?.goals?.setActive) {
        return
      }
      await window.api.goals.setActive({ workspacePath, goalId })
      await refresh()
    },
    [workspacePath, refresh]
  )

  const toggleSubtask = useCallback(
    async (goalId: string, subtaskId: string, completed: boolean): Promise<void> => {
      if (!workspacePath || !window.api?.goals?.toggleSubtask) {
        return
      }
      await window.api.goals.toggleSubtask({ workspacePath, goalId, subtaskId, completed })
      await refresh()
    },
    [workspacePath, refresh]
  )

  const updateGoal = useCallback(
    async (goalId: string, updates: Partial<Goal>): Promise<void> => {
      if (!workspacePath || !window.api?.goals?.updateGoal) {
        return
      }
      await window.api.goals.updateGoal({ workspacePath, goalId, updates })
      await refresh()
    },
    [workspacePath, refresh]
  )

  const deleteGoal = useCallback(
    async (goalId: string): Promise<void> => {
      if (!workspacePath || !window.api?.goals?.deleteGoal) {
        return
      }
      await window.api.goals.deleteGoal({ workspacePath, goalId })
      await refresh()
    },
    [workspacePath, refresh]
  )

  const runValidation = useCallback(
    async (goalId?: string): Promise<GoalValidation | undefined> => {
      if (!workspacePath || !window.api?.goals?.runValidation) {
        return undefined
      }
      const validation = await window.api.goals.runValidation({ workspacePath, goalId })
      await refresh()
      return validation
    },
    [workspacePath, refresh]
  )

  const activeGoal = data?.goals.find((goal) => goal.id === data.activeGoalId) ?? null

  return {
    data,
    activeGoal,
    isLoading,
    error,
    refresh,
    createGoal,
    setActiveGoal,
    toggleSubtask,
    updateGoal,
    deleteGoal,
    runValidation
  }
}
