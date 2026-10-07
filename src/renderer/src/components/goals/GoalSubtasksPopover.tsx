import { useState } from 'react'
import { CheckSquare, Plus } from 'lucide-react'
import type { GoalSubtask } from '../../../../shared/goals/goals-schema'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { GoalSubtaskWorkerBadge } from './GoalSubtaskWorkerBadge'

export type GoalSubtasksPopoverProps = {
  subtasks: GoalSubtask[]
  onToggleSubtask: (subtaskId: string, completed: boolean) => void
  onAddSubtask?: (title: string) => void
  onAssignWorker?: (subtaskId: string, agent: string) => void
}

export function GoalSubtasksPopover({
  subtasks,
  onToggleSubtask,
  onAddSubtask,
  onAssignWorker
}: GoalSubtasksPopoverProps): React.JSX.Element {
  const [newTitle, setNewTitle] = useState('')
  const completedCount = subtasks.filter((s) => s.completed).length

  const handleAdd = () => {
    const trimmed = newTitle.trim()
    if (!trimmed) {
      return
    }
    onAddSubtask?.(trimmed)
    setNewTitle('')
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" aria-label="Ver subtareas">
          <CheckSquare className="size-3.5" />
          <span>
            {completedCount}/{subtasks.length}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="start">
        <div className="p-3 text-xs">
          <div className="mb-2 flex items-center justify-between font-medium">
            <span>Subtareas</span>
            <span className="text-muted-foreground">
              {completedCount} de {subtasks.length} completadas
            </span>
          </div>

          <div className="max-h-52 space-y-1.5 overflow-y-auto scrollbar-sleek pr-1">
            {subtasks.length === 0 ? (
              <p className="py-2 text-center text-muted-foreground">No hay subtareas definidas.</p>
            ) : (
              subtasks.map((subtask) => (
                <div
                  key={subtask.id}
                  className="flex items-center justify-between gap-1.5 rounded p-1 hover:bg-muted/50"
                >
                  <label className="flex cursor-pointer items-start gap-2 flex-1 min-w-0">
                    <Checkbox
                      checked={subtask.completed}
                      onCheckedChange={(checked) => onToggleSubtask(subtask.id, Boolean(checked))}
                      className="mt-0.5"
                    />
                    <span
                      className={cn(
                        'select-none text-xs leading-tight',
                        subtask.completed && 'line-through text-muted-foreground'
                      )}
                    >
                      {subtask.title}
                    </span>
                  </label>
                  <GoalSubtaskWorkerBadge
                    worker={subtask.worker}
                    onAssignWorker={
                      onAssignWorker ? (agent) => onAssignWorker(subtask.id, agent) : undefined
                    }
                  />
                </div>
              ))
            )}
          </div>

          {onAddSubtask && (
            <div className="mt-2.5 flex items-center gap-1.5 border-t border-border pt-2">
              <Input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleAdd()
                  }
                }}
                placeholder="Añadir subtarea..."
              />
              <Button
                variant="secondary"
                size="xs"
                onClick={handleAdd}
                disabled={!newTitle.trim()}
                aria-label="Añadir"
              >
                <Plus className="size-3.5" />
              </Button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
