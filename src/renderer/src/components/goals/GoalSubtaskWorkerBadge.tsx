import React from 'react'
import { Bot, ChevronDown, Check } from 'lucide-react'
import type { GoalSubtaskWorker } from '../../../../shared/goals/goals-schema'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export const AVAILABLE_WORKER_AGENTS = ['claude', 'codex', 'antigravity'] as const

export type GoalSubtaskWorkerBadgeProps = {
  worker?: GoalSubtaskWorker
  onAssignWorker?: (agent: string) => void
  size?: 'xs' | 'sm'
}

export function GoalSubtaskWorkerBadge({
  worker,
  onAssignWorker,
  size = 'xs'
}: GoalSubtaskWorkerBadgeProps): React.JSX.Element | null {
  if (!onAssignWorker && !worker) {
    return null
  }

  const statusColor =
    worker?.status === 'completed'
      ? 'bg-workspace-status-review'
      : worker?.status === 'running'
        ? 'bg-annotation-highlight animate-pulse'
        : worker?.status === 'failed'
          ? 'bg-destructive'
          : 'bg-muted-foreground'

  if (!onAssignWorker) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded border border-border/50 bg-muted/50 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground"
        title={`Worker: ${worker?.agent} (${worker?.status})`}
      >
        <Bot className="size-3 text-primary" />
        <span>{worker?.agent}</span>
        <span className={cn('size-1.5 rounded-full', statusColor)} />
      </span>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {worker ? (
          <Button
            variant="outline"
            size={size}
            title={`Worker: ${worker.agent} (${worker.status}) - Clic para cambiar`}
          >
            <Bot className="size-2.5 text-primary mr-0.5" />
            <span className="truncate max-w-[60px] font-mono">{worker.agent}</span>
            <span className={cn('size-1.5 rounded-full mx-0.5', statusColor)} />
            <ChevronDown className="size-2.5 opacity-60 ml-0.5" />
          </Button>
        ) : (
          <Button variant="ghost" size={size} title="Asignar worker a esta tarea">
            <Bot className="size-2.5 mr-1" />
            <span>+ Worker</span>
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <div className="px-2 py-1 text-[10px] font-medium text-muted-foreground">
          Asignar agente
        </div>
        {AVAILABLE_WORKER_AGENTS.map((agent) => (
          <DropdownMenuItem
            key={agent}
            onClick={() => onAssignWorker(agent)}
            className="flex items-center justify-between"
          >
            <div className="flex items-center gap-1.5">
              <Bot className="size-3 text-primary" />
              <span>{agent}</span>
            </div>
            {worker?.agent === agent ? <Check className="size-3 text-primary" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
