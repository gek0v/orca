import React, { useEffect, useMemo, useState } from 'react'
import { FolderGit2, Plus, Target, X } from 'lucide-react'
import { toast } from 'sonner'
import type { Goal, GoalStatus } from '../../../../shared/goals/goals-schema'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { CreateGoalDialog, type CreateGoalFormData } from './CreateGoalDialog'
import { GoalCard } from './GoalCard'
import { useWorkspaceGoals } from './use-workspace-goals'

export default function GoalsPage(): React.JSX.Element {
  const closeGoalsPage = useAppStore((state) => state.closeGoalsPage)
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const worktreesByRepo = useAppStore((state) => state.worktreesByRepo)

  const worktrees = useMemo(() => Object.values(worktreesByRepo).flat(), [worktreesByRepo])

  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(null)

  const effectiveWorktreeId = selectedWorktreeId ?? activeWorktreeId ?? worktrees[0]?.id ?? null

  const currentWorktree = useMemo(() => {
    return worktrees.find((wt) => wt.id === effectiveWorktreeId) ?? null
  }, [worktrees, effectiveWorktreeId])

  const currentWorktreePath = currentWorktree?.path

  const {
    data,
    isLoading,
    createGoal,
    setActiveGoal,
    toggleSubtask,
    updateGoal,
    deleteGoal,
    runValidation
  } = useWorkspaceGoals(currentWorktreePath)

  const [createOpen, setCreateOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | GoalStatus>('all')
  const [validatingGoalIds, setValidatingGoalIds] = useState<Record<string, boolean>>({})

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return
      }
      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable
      ) {
        event.preventDefault()
        target.blur()
        return
      }
      if (createOpen) {
        return
      }
      event.preventDefault()
      closeGoalsPage()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeGoalsPage, createOpen])

  const handleCreateSubmit = async (formData: CreateGoalFormData) => {
    try {
      const created = await createGoal(formData.title, {
        description: formData.description,
        subtasks: formData.subtasks,
        validationCommand: formData.validationCommand
      })

      if (created && formData.setActiveImmediately) {
        await setActiveGoal(created.id)
      }

      toast.success(
        translate('auto.components.goals.GoalsPage.createdSuccess', 'Objetivo creado exitosamente')
      )
      setCreateOpen(false)
    } catch (err) {
      console.error('Failed to create goal:', err)
      toast.error(
        translate('auto.components.goals.GoalsPage.createError', 'Error al crear el objetivo')
      )
    }
  }

  const handleDeleteGoal = async (goalId: string, title: string) => {
    try {
      await deleteGoal(goalId)
      toast.success(`Objetivo "${title}" eliminado`)
    } catch (err) {
      console.error('Failed to delete goal:', err)
      toast.error('Error al eliminar el objetivo')
    }
  }

  const handleAddSubtask = async (goal: Goal, text: string) => {
    const updatedSubtasks = [
      ...goal.subtasks,
      {
        id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        title: text,
        completed: false
      }
    ]
    await updateGoal(goal.id, { subtasks: updatedSubtasks })
  }

  const handleRemoveSubtask = async (goal: Goal, subtaskId: string) => {
    const updatedSubtasks = goal.subtasks.filter((s) => s.id !== subtaskId)
    await updateGoal(goal.id, { subtasks: updatedSubtasks })
  }

  const handleRunValidation = async (goalId: string) => {
    try {
      setValidatingGoalIds((prev) => ({ ...prev, [goalId]: true }))
      const res = await runValidation(goalId)
      if (res?.status === 'success') {
        toast.success('Validación exitosa')
      } else if (res?.status === 'failed') {
        toast.error('Validación fallida')
      }
    } catch (err) {
      console.error('Validation failed:', err)
      toast.error('Error ejecutando validación')
    } finally {
      setValidatingGoalIds((prev) => ({ ...prev, [goalId]: false }))
    }
  }

  const goals = useMemo(() => data?.goals ?? [], [data?.goals])
  const activeGoalId = data?.activeGoalId

  const filteredGoals = useMemo(() => {
    return goals.filter((g) => {
      if (statusFilter === 'active' && g.id !== activeGoalId) {
        return false
      }
      if (statusFilter !== 'all' && statusFilter !== 'active' && g.status !== statusFilter) {
        return false
      }
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase()
        const matchesTitle = g.title.toLowerCase().includes(query)
        const matchesDesc = g.description?.toLowerCase().includes(query)
        const matchesSubtask = g.subtasks.some((s) => s.title.toLowerCase().includes(query))
        return matchesTitle || matchesDesc || matchesSubtask
      }
      return true
    })
  }, [goals, activeGoalId, statusFilter, searchQuery])

  return (
    <main className="relative flex h-full min-h-0 flex-1 flex-col bg-background pt-5 text-foreground md:pt-6">
      <header
        className="flex shrink-0 items-center justify-between px-3 pb-4 md:px-6"
        style={{ paddingRight: 'max(0.75rem, var(--window-controls-width, 0px))' }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={closeGoalsPage}
            title={translate('auto.components.goals.GoalsPage.close', 'Cerrar · Esc')}
            aria-label="Cerrar"
          >
            <X className="size-4" />
          </Button>

          <div className="flex items-center gap-2 min-w-0">
            <Target className="size-5 shrink-0 text-foreground" />
            <h1 className="truncate text-base font-semibold leading-8">
              {translate('auto.components.goals.GoalsPage.title', 'Objetivos')}
            </h1>
          </div>

          {worktrees.length > 1 ? (
            <Select
              value={currentWorktree?.id ?? ''}
              onValueChange={(val) => setSelectedWorktreeId(val)}
            >
              <SelectTrigger size="sm" className="max-w-[220px]">
                <SelectValue placeholder="Seleccionar espacio..." />
              </SelectTrigger>
              <SelectContent>
                {worktrees.map((wt) => (
                  <SelectItem key={wt.id} value={wt.id}>
                    {wt.displayName || wt.path}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : currentWorktree ? (
            <Badge variant="outline" className="max-w-[220px]">
              <FolderGit2 className="size-3 mr-1 shrink-0" />
              <span className="truncate">{currentWorktree.displayName}</span>
            </Badge>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setCreateOpen(true)} disabled={!currentWorktreePath}>
            <Plus className="size-4 mr-1.5" />
            {translate('auto.components.goals.GoalsPage.newGoal', 'Nuevo objetivo')}
          </Button>
        </div>
      </header>

      <div className="flex flex-1 min-h-0 flex-col overflow-y-auto px-3 pb-8 md:px-6 scrollbar-sleek">
        {!currentWorktreePath ? (
          <div className="flex flex-col items-center justify-center flex-1 py-16 text-center text-muted-foreground">
            <Target className="size-12 mb-3 text-muted-foreground/40" />
            <p className="text-base font-medium text-foreground">
              {translate(
                'auto.components.goals.GoalsPage.noWorkspace',
                'No hay espacio de trabajo activo'
              )}
            </p>
            <p className="text-sm max-w-sm mt-1">
              {translate(
                'auto.components.goals.GoalsPage.selectWorkspacePrompt',
                'Selecciona o abre un espacio de trabajo para definir y seguir sus objetivos.'
              )}
            </p>
          </div>
        ) : isLoading && !data ? (
          <div className="space-y-4 pt-2">
            {[1, 2].map((i) => (
              <div key={i} className="animate-pulse rounded-xl border border-border/50 bg-card p-6">
                <div className="h-5 bg-muted rounded w-1/3 mb-2" />
                <div className="h-4 bg-muted/60 rounded w-1/2 mb-4" />
                <div className="h-10 bg-muted/40 rounded" />
              </div>
            ))}
          </div>
        ) : goals.length === 0 ? (
          <div className="flex flex-col items-center justify-center flex-1 py-16 text-center">
            <div className="size-12 rounded-full bg-muted flex items-center justify-center mb-4">
              <Target className="size-6 text-muted-foreground" />
            </div>
            <h2 className="text-base font-semibold text-foreground">
              {translate(
                'auto.components.goals.GoalsPage.emptyTitle',
                'No hay objetivos definidos'
              )}
            </h2>
            <p className="text-sm text-muted-foreground max-w-md mt-1 mb-5">
              {translate(
                'auto.components.goals.GoalsPage.emptyDescription',
                'Define metas, desglosa tareas y configura validaciones técnicas automatizadas para este espacio de trabajo.'
              )}
            </p>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4 mr-1.5" />
              {translate('auto.components.goals.GoalsPage.defineFirst', 'Definir primer objetivo')}
            </Button>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <div className="flex items-center gap-2 flex-1 max-w-xs">
                <Input
                  placeholder="Buscar objetivos o tareas..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="h-8"
                />
              </div>

              <div className="flex items-center gap-1.5">
                <Button
                  variant={statusFilter === 'all' ? 'secondary' : 'ghost'}
                  size="xs"
                  onClick={() => setStatusFilter('all')}
                >
                  Todos ({goals.length})
                </Button>
                <Button
                  variant={statusFilter === 'active' ? 'secondary' : 'ghost'}
                  size="xs"
                  onClick={() => setStatusFilter('active')}
                >
                  Activo
                </Button>
                <Button
                  variant={statusFilter === 'in_progress' ? 'secondary' : 'ghost'}
                  size="xs"
                  onClick={() => setStatusFilter('in_progress')}
                >
                  En progreso
                </Button>
                <Button
                  variant={statusFilter === 'completed' ? 'secondary' : 'ghost'}
                  size="xs"
                  onClick={() => setStatusFilter('completed')}
                >
                  Completados
                </Button>
              </div>
            </div>

            {filteredGoals.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                No se encontraron objetivos con los filtros aplicados.
              </div>
            ) : (
              <div className="grid gap-4">
                {filteredGoals.map((goal) => (
                  <GoalCard
                    key={goal.id}
                    goal={goal}
                    isActive={goal.id === activeGoalId}
                    isValidating={Boolean(validatingGoalIds[goal.id])}
                    onSetActive={(id) => void setActiveGoal(id)}
                    onUpdateStatus={(id, status) => void updateGoal(id, { status })}
                    onDeleteGoal={(id, title) => void handleDeleteGoal(id, title)}
                    onToggleSubtask={(id, subId, comp) => void toggleSubtask(id, subId, comp)}
                    onAddSubtask={(g, text) => void handleAddSubtask(g, text)}
                    onRemoveSubtask={(g, subId) => void handleRemoveSubtask(g, subId)}
                    onRunValidation={(id) => void handleRunValidation(id)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <CreateGoalDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={handleCreateSubmit}
      />
    </main>
  )
}
