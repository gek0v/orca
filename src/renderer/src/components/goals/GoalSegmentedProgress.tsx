import type { GoalSubtask } from '../../../../shared/goals/goals-schema'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export type GoalSegmentedProgressProps = {
  subtasks: GoalSubtask[]
  className?: string
}

export function GoalSegmentedProgress({
  subtasks,
  className
}: GoalSegmentedProgressProps): React.JSX.Element | null {
  if (subtasks.length === 0) {
    return null
  }

  return (
    <TooltipProvider>
      <div
        className={cn('flex h-2 w-24 items-center gap-1 sm:w-32', className)}
        role="progressbar"
        aria-label="Progreso de subtareas"
      >
        {subtasks.map((subtask) => (
          <Tooltip key={subtask.id}>
            <TooltipTrigger asChild>
              <div
                className={cn(
                  'h-1.5 flex-1 rounded-full transition-colors',
                  subtask.completed ? 'bg-primary' : 'bg-muted/50'
                )}
                data-completed={subtask.completed}
              />
            </TooltipTrigger>
            <TooltipContent side="top">
              <span className="text-xs">
                {subtask.completed ? '✓ ' : '○ '}
                {subtask.title}
              </span>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  )
}
