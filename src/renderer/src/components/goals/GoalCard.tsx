import React, { useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Play,
  Plus,
  Star,
  Trash2,
  X
} from 'lucide-react'
import type { Goal, GoalStatus } from '../../../../shared/goals/goals-schema'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { GoalSubtaskWorkerBadge } from './GoalSubtaskWorkerBadge'

export const GOAL_STATUS_ENTRIES = [
  { status: 'pending', label: 'Pendiente' },
  { status: 'in_progress', label: 'En progreso' },
  { status: 'in_verification', label: 'En verificación' },
  { status: 'completed', label: 'Completado' },
  { status: 'failed', label: 'Fallido' }
] as const satisfies readonly { status: GoalStatus; label: string }[]

export type GoalCardProps = {
  goal: Goal
  isActive: boolean
  isValidating: boolean
  onSetActive: (goalId: string | null) => void
  onUpdateStatus: (goalId: string, status: GoalStatus) => void
  onDeleteGoal: (goalId: string, title: string) => void
  onToggleSubtask: (goalId: string, subtaskId: string, completed: boolean) => void
  onAddSubtask: (goal: Goal, title: string) => void
  onRemoveSubtask: (goal: Goal, subtaskId: string) => void
  onRunValidation: (goalId: string) => void
  onAssignWorker?: (goalId: string, subtaskId: string, agent: string) => void
}

export function GoalCard({
  goal,
  isActive,
  isValidating,
  onSetActive,
  onUpdateStatus,
  onDeleteGoal,
  onToggleSubtask,
  onAddSubtask,
  onRemoveSubtask,
  onRunValidation,
  onAssignWorker
}: GoalCardProps): React.JSX.Element {
  const [inlineTitle, setInlineTitle] = useState('')
  const [isOutputOpen, setIsOutputOpen] = useState(false)

  const completedSubtasks = goal.subtasks.filter((s) => s.completed).length
  const totalSubtasks = goal.subtasks.length
  const progressPct = totalSubtasks > 0 ? Math.round((completedSubtasks / totalSubtasks) * 100) : 0

  const handleInlineAdd = () => {
    const text = inlineTitle.trim()
    if (!text) {
      return
    }
    onAddSubtask(goal, text)
    setInlineTitle('')
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {isActive ? (
              <Badge variant="default">
                <Star className="size-3 fill-current mr-1" />
                Meta activa
              </Badge>
            ) : null}

            <Select
              value={goal.status}
              onValueChange={(val: GoalStatus) => onUpdateStatus(goal.id, val)}
            >
              <SelectTrigger size="sm" className="h-6">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GOAL_STATUS_ENTRIES.map(({ status, label }) => (
                  <SelectItem key={status} value={status}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {!isActive ? (
              <Button
                variant="outline"
                size="xs"
                onClick={() => onSetActive(goal.id)}
                title="Establecer como meta activa en la barra inferior"
              >
                Hacer activa
              </Button>
            ) : (
              <Button variant="ghost" size="xs" onClick={() => onSetActive(null)}>
                Desactivar
              </Button>
            )}
          </div>

          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => onDeleteGoal(goal.id, goal.title)}
            title="Eliminar objetivo"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>

        <CardTitle>{goal.title}</CardTitle>

        {goal.description ? (
          <CardDescription className="whitespace-pre-wrap">{goal.description}</CardDescription>
        ) : null}
      </CardHeader>

      <CardContent>
        <div className="space-y-4">
          {totalSubtasks > 0 ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Sub-tareas completadas</span>
                <span className="font-mono">
                  {completedSubtasks}/{totalSubtasks} ({progressPct}%)
                </span>
              </div>
              <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          ) : null}

          <div className="space-y-2">
            <p className="text-xs font-medium text-foreground">Tareas</p>
            <div className="space-y-1.5">
              {goal.subtasks.map((task) => (
                <div
                  key={task.id}
                  className="flex items-center justify-between group rounded-md px-2 py-1 hover:bg-muted/40 transition-colors gap-2"
                >
                  <label className="flex items-center gap-2.5 flex-1 min-w-0 cursor-pointer">
                    <Checkbox
                      checked={task.completed}
                      onCheckedChange={(checked) =>
                        onToggleSubtask(goal.id, task.id, Boolean(checked))
                      }
                    />
                    <span
                      className={cn(
                        'text-xs truncate transition-colors select-none',
                        task.completed && 'line-through text-muted-foreground'
                      )}
                    >
                      {task.title}
                    </span>
                  </label>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <GoalSubtaskWorkerBadge
                      worker={task.worker}
                      onAssignWorker={
                        onAssignWorker
                          ? (agent) => onAssignWorker(goal.id, task.id, agent)
                          : undefined
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => onRemoveSubtask(goal, task.id)}
                      title="Eliminar tarea"
                    >
                      <X className="size-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-2 pt-1">
              <Input
                placeholder="Añadir nueva sub-tarea..."
                value={inlineTitle}
                onChange={(e) => setInlineTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleInlineAdd()
                  }
                }}
                className="h-7"
              />
              <Button
                variant="secondary"
                size="xs"
                onClick={handleInlineAdd}
                disabled={!inlineTitle.trim()}
              >
                <Plus className="size-3 mr-1" />
                Añadir
              </Button>
            </div>
          </div>

          <div className="pt-2 border-t border-border/50">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-foreground">Validación:</span>
                {goal.validation?.command ? (
                  <code className="bg-muted px-2 py-0.5 rounded text-xs font-mono text-muted-foreground">
                    {goal.validation.command}
                  </code>
                ) : (
                  <span className="text-xs text-muted-foreground italic">
                    Sin comando configurado
                  </span>
                )}
              </div>

              {goal.validation?.command ? (
                <div className="flex items-center gap-2">
                  {goal.validation.status === 'success' ? (
                    <Badge variant="outline">
                      <CheckCircle2 className="size-3 text-primary mr-1" />
                      Exitosa
                    </Badge>
                  ) : goal.validation.status === 'failed' ? (
                    <Badge variant="destructive">
                      <AlertCircle className="size-3 mr-1" />
                      Fallida
                    </Badge>
                  ) : null}

                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => onRunValidation(goal.id)}
                    disabled={isValidating}
                  >
                    {isValidating ? (
                      <Loader2 className="size-3 animate-spin mr-1" />
                    ) : (
                      <Play className="size-3 mr-1" />
                    )}
                    Ejecutar validación
                  </Button>
                </div>
              ) : null}
            </div>

            {goal.validation?.summaryTail ? (
              <div className="mt-2.5">
                <button
                  type="button"
                  onClick={() => setIsOutputOpen((open) => !open)}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer font-medium"
                >
                  {isOutputOpen ? (
                    <ChevronDown className="size-3.5" />
                  ) : (
                    <ChevronRight className="size-3.5" />
                  )}
                  Salida de validación (última ejecución)
                </button>

                {isOutputOpen ? (
                  <pre className="mt-2 p-2.5 rounded bg-muted/60 text-xs font-mono text-foreground overflow-x-auto whitespace-pre-wrap max-h-40 border border-border/40">
                    {goal.validation.summaryTail}
                  </pre>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
