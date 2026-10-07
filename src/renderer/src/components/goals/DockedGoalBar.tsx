import { useState } from 'react'
import { Check, ChevronDown, Plus, Sparkles, Target } from 'lucide-react'
import { toast } from 'sonner'
import type { Goal } from '../../../../shared/goals/goals-schema'
import { useAppStore } from '../../store'
import { getWorktreeMapFromState } from '../../store/selectors'
import type { TerminalController } from '../use-terminal-controller'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { GoalSegmentedProgress } from './GoalSegmentedProgress'
import { GoalSubtasksPopover } from './GoalSubtasksPopover'
import { GoalValidationBadge } from './GoalValidationBadge'
import { useWorkspaceGoals } from './use-workspace-goals'

export type DockedGoalBarProps = {
  controller?: TerminalController
  worktreeId?: string | null
  activeGoal?: Goal | null
}

export function DockedGoalBar({
  controller,
  worktreeId: worktreeIdProp,
  activeGoal: activeGoalProp
}: DockedGoalBarProps): React.JSX.Element | null {
  const effectiveWorktreeId = worktreeIdProp ?? controller?.renderedActiveWorktreeId ?? null

  const worktreePath = useAppStore((state) => {
    if (!effectiveWorktreeId) {
      return undefined
    }
    const worktree = getWorktreeMapFromState(state).get(effectiveWorktreeId)
    return worktree?.path
  })

  const activeTabId = controller?.activeTabId
  const activePtyId = useAppStore((state) => {
    if (!effectiveWorktreeId) {
      return undefined
    }
    const tabs = state.tabsByWorktree[effectiveWorktreeId]
    const tab = tabs?.find((t) => t.id === activeTabId) ?? tabs?.[0]
    return tab?.ptyId ?? undefined
  })

  const goalsHook = useWorkspaceGoals(worktreePath)
  const currentGoal = activeGoalProp !== undefined ? activeGoalProp : goalsHook.activeGoal
  const goalsList = goalsHook.data?.goals ?? (currentGoal ? [currentGoal] : [])

  const [isCreatingGoal, setIsCreatingGoal] = useState(false)
  const [newGoalTitle, setNewGoalTitle] = useState('')

  if (!effectiveWorktreeId && !activeGoalProp) {
    return null
  }

  const handleCreateGoal = async () => {
    const trimmed = newGoalTitle.trim()
    if (!trimmed) {
      return
    }
    await goalsHook.createGoal(trimmed)
    setNewGoalTitle('')
    setIsCreatingGoal(false)
  }

  const handleToggleSubtask = async (subtaskId: string, completed: boolean) => {
    if (!currentGoal) {
      return
    }
    await goalsHook.toggleSubtask(currentGoal.id, subtaskId, completed)
  }

  const handleAddSubtask = async (title: string) => {
    if (!currentGoal) {
      return
    }
    const updatedSubtasks = [
      ...currentGoal.subtasks,
      { id: `task-${Date.now()}`, title, completed: false }
    ]
    await goalsHook.updateGoal(currentGoal.id, { subtasks: updatedSubtasks })
  }

  const handleQuickAssist = async () => {
    if (!currentGoal) {
      return
    }
    const nextSubtask = currentGoal.subtasks.find((s) => !s.completed)
    const prompt = nextSubtask
      ? `Continúa con la tarea: "${nextSubtask.title}"`
      : `Todas las tareas completadas para la meta "${currentGoal.title}". Ejecuta la validación técnica.`

    if (activePtyId && window.api?.pty?.write) {
      window.api.pty.write(activePtyId, prompt, 'driving')
      toast.info('Instrucción enviada al terminal')
    } else {
      if (window.api?.ui?.writeClipboardText) {
        await window.api.ui.writeClipboardText(prompt)
      } else if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(prompt)
      }
      toast.success('Instrucción copiada al portapapeles')
    }
  }

  if (!currentGoal) {
    return (
      <div
        className="flex h-9 w-full shrink-0 items-center justify-between border-b border-border bg-card/30 px-3 text-xs select-none"
        data-docked-goal-bar
      >
        <Popover open={isCreatingGoal} onOpenChange={setIsCreatingGoal}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="xs">
              <Target className="size-3.5 text-muted-foreground" />
              <span>+ Definir meta</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72" align="start">
            <div className="p-3 text-xs">
              <div className="mb-2 font-medium">Nuevo Objetivo</div>
              <div className="space-y-2">
                <Input
                  placeholder="Nombre del objetivo..."
                  value={newGoalTitle}
                  onChange={(e) => setNewGoalTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void handleCreateGoal()
                    }
                  }}
                  autoFocus
                />
                <div className="flex justify-end gap-1.5">
                  <Button variant="outline" size="xs" onClick={() => setIsCreatingGoal(false)}>
                    Cancelar
                  </Button>
                  <Button
                    variant="default"
                    size="xs"
                    onClick={handleCreateGoal}
                    disabled={!newGoalTitle.trim()}
                  >
                    Crear
                  </Button>
                </div>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    )
  }

  return (
    <div
      className="flex h-9 w-full shrink-0 items-center justify-between border-b border-border bg-card/30 px-3 text-xs select-none"
      data-docked-goal-bar
    >
      {/* Left side: Goal switcher & subtasks progress */}
      <div className="flex min-w-0 items-center gap-2 overflow-hidden">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              className="max-w-[200px] sm:max-w-[280px]"
              aria-label="Seleccionar meta activa"
            >
              <Target className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{currentGoal.title}</span>
              <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            {goalsList.map((goal) => (
              <DropdownMenuItem key={goal.id} onClick={() => void goalsHook.setActiveGoal(goal.id)}>
                <div className="flex w-full items-center justify-between gap-2 text-xs">
                  <span className="truncate">{goal.title}</span>
                  {goal.id === currentGoal.id && (
                    <Check className="size-3.5 shrink-0 text-primary" />
                  )}
                </div>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setIsCreatingGoal(true)}>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Plus className="size-3.5" />
                <span>Nueva meta...</span>
              </div>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <GoalSegmentedProgress subtasks={currentGoal.subtasks} />

        <GoalSubtasksPopover
          subtasks={currentGoal.subtasks}
          onToggleSubtask={handleToggleSubtask}
          onAddSubtask={handleAddSubtask}
        />
      </div>

      {/* Right side: Validation badge & Quick assist */}
      <div className="flex shrink-0 items-center gap-2">
        <GoalValidationBadge
          validation={currentGoal.validation}
          onRunValidation={() => void goalsHook.runValidation(currentGoal.id)}
        />

        <Button
          variant="ghost"
          size="xs"
          onClick={handleQuickAssist}
          aria-label="Asistir con siguiente tarea"
        >
          <Sparkles className="size-3 text-primary" />
          <span className="hidden sm:inline">Asistir</span>
        </Button>
      </div>

      {/* Dialog / Popover to create a new goal when triggered from dropdown */}
      <Popover open={isCreatingGoal} onOpenChange={setIsCreatingGoal}>
        <PopoverContent className="w-72" align="start">
          <div className="p-3 text-xs">
            <div className="mb-2 font-medium">Nuevo Objetivo</div>
            <div className="space-y-2">
              <Input
                placeholder="Nombre del objetivo..."
                value={newGoalTitle}
                onChange={(e) => setNewGoalTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void handleCreateGoal()
                  }
                }}
                autoFocus
              />
              <div className="flex justify-end gap-1.5">
                <Button variant="outline" size="xs" onClick={() => setIsCreatingGoal(false)}>
                  Cancelar
                </Button>
                <Button
                  variant="default"
                  size="xs"
                  onClick={handleCreateGoal}
                  disabled={!newGoalTitle.trim()}
                >
                  Crear
                </Button>
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
