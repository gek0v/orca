import { Loader2, RotateCw } from 'lucide-react'
import type { GoalValidation } from '../../../../shared/goals/goals-schema'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export type GoalValidationBadgeProps = {
  validation?: GoalValidation
  onRunValidation?: () => void
  isRunning?: boolean
}

export function GoalValidationBadge({
  validation,
  onRunValidation,
  isRunning = false
}: GoalValidationBadgeProps): React.JSX.Element {
  const status = isRunning ? 'running' : (validation?.status ?? 'idle')

  const renderBadgeContent = () => {
    switch (status) {
      case 'running':
        return (
          <>
            <Loader2 className="size-3 animate-spin text-primary" />
            <span>Ejecutando</span>
          </>
        )
      case 'success':
        return (
          <>
            <span className="size-1.5 rounded-full bg-primary" />
            <span>Exitosa</span>
          </>
        )
      case 'failed':
        return (
          <>
            <span className="size-1.5 rounded-full bg-destructive" />
            <span>Fallida</span>
          </>
        )
      case 'idle':
        return (
          <>
            <span className="size-1.5 rounded-full bg-muted-foreground/50" />
            <span>Validación</span>
          </>
        )
    }
  }

  const badgeVariant = status === 'failed' ? 'destructive' : 'outline'

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="focus-visible:ring-ring inline-flex cursor-pointer items-center rounded-full outline-none focus-visible:ring-1"
          aria-label="Estado de validación"
        >
          <Badge variant={badgeVariant}>
            <span className="flex items-center gap-1.5">{renderBadgeContent()}</span>
          </Badge>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="end">
        <div className="p-3 text-xs">
          <div className="mb-2 flex items-center justify-between font-medium">
            <span>Validación Técnica</span>
            {onRunValidation && (
              <Button
                size="xs"
                variant="outline"
                onClick={onRunValidation}
                disabled={status === 'running'}
              >
                <RotateCw className={cn('size-3', status === 'running' && 'animate-spin')} />
                Re-ejecutar
              </Button>
            )}
          </div>

          {validation ? (
            <div className="space-y-2">
              <div>
                <div className="mb-1 text-muted-foreground">Comando:</div>
                <div className="rounded bg-muted/60 p-1.5 font-mono break-all select-text">
                  {validation.command}
                </div>
              </div>

              {validation.exitCode !== undefined && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <span>Código de salida:</span>
                  <span
                    className={cn(
                      'font-mono font-medium',
                      validation.exitCode === 0 ? 'text-primary' : 'text-destructive'
                    )}
                  >
                    {validation.exitCode}
                  </span>
                </div>
              )}

              {validation.summaryTail && (
                <div>
                  <div className="mb-1 text-muted-foreground">Resumen:</div>
                  <pre className="max-h-24 overflow-auto scrollbar-sleek rounded bg-muted/40 p-1.5 font-mono whitespace-pre-wrap select-text">
                    {validation.summaryTail}
                  </pre>
                </div>
              )}

              <div className="text-muted-foreground">
                Log completo en <code className="font-mono">.orca/last_validation.log</code>
              </div>
            </div>
          ) : (
            <p className="py-2 text-center text-muted-foreground">
              No hay comando de validación configurado.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
