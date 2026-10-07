import React, { useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { GoalAiGenerated } from '../../../../shared/goals/goals-ai'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

export type CreateGoalFormData = {
  title: string
  description?: string
  subtasks?: string[]
  validationCommand?: string
  setActiveImmediately: boolean
}

export type CreateGoalDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (data: CreateGoalFormData) => Promise<void>
  onGenerateWithAi?: (prompt: string) => Promise<GoalAiGenerated | undefined>
}

export function CreateGoalDialog({
  open,
  onOpenChange,
  onSubmit,
  onGenerateWithAi
}: CreateGoalDialogProps): React.JSX.Element {
  const [newTitle, setNewTitle] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newSubtasks, setNewSubtasks] = useState('')
  const [newValidationCmd, setNewValidationCmd] = useState('')
  const [aiPrompt, setAiPrompt] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [setActiveImmediately, setSetActiveImmediately] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleGenerate = async () => {
    const prompt = aiPrompt.trim() || newTitle.trim()
    if (!prompt || !onGenerateWithAi) {
      return
    }
    try {
      setIsGenerating(true)
      const res = await onGenerateWithAi(prompt)
      if (res) {
        setNewTitle(res.title)
        if (res.description) {
          setNewDescription(res.description)
        }
        if (res.subtasks?.length) {
          setNewSubtasks(res.subtasks.join('\n'))
        }
        if (res.validationCommand) {
          setNewValidationCmd(res.validationCommand)
        }
      }
    } finally {
      setIsGenerating(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmedTitle = newTitle.trim()
    if (!trimmedTitle) {
      return
    }

    try {
      setIsSubmitting(true)
      const subtasksArray = newSubtasks
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)

      await onSubmit({
        title: trimmedTitle,
        description: newDescription.trim() || undefined,
        subtasks: subtasksArray.length > 0 ? subtasksArray : undefined,
        validationCommand: newValidationCmd.trim() || undefined,
        setActiveImmediately
      })

      setNewTitle('')
      setNewDescription('')
      setNewSubtasks('')
      setNewValidationCmd('')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {translate('auto.components.goals.GoalsPage.dialogTitle', 'Crear nuevo objetivo')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.goals.GoalsPage.dialogDesc',
                'Define una meta técnica y sus sub-tareas para este espacio de trabajo.'
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {onGenerateWithAi ? (
              <div className="flex items-center gap-2 rounded-md border border-border/70 bg-muted/40 p-2">
                <Sparkles className="size-3.5 text-primary shrink-0" />
                <Input
                  className="h-7 flex-1"
                  placeholder="Describe lo que quieres lograr con IA..."
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void handleGenerate()
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="xs"
                  onClick={handleGenerate}
                  disabled={isGenerating || (!aiPrompt.trim() && !newTitle.trim())}
                >
                  {isGenerating ? (
                    <Loader2 className="size-3 animate-spin mr-1" />
                  ) : (
                    <Sparkles className="size-3 mr-1" />
                  )}
                  Generar con IA
                </Button>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Título del objetivo *</label>
              <Input
                required
                placeholder="ej. Implementar autenticación OAuth"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Descripción (opcional)</label>
              <Textarea
                placeholder="Detalles, criterios de aceptación o contexto..."
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                className="min-h-18"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">
                Sub-tareas iniciales (una por línea)
              </label>
              <Textarea
                placeholder={`Crear rutas de callback\nGuardar tokens de sesión\nValidar expiración`}
                value={newSubtasks}
                onChange={(e) => setNewSubtasks(e.target.value)}
                variant="code"
                className="min-h-20"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">
                Comando de validación (opcional)
              </label>
              <Input
                placeholder="ej. pnpm test src/auth/"
                value={newValidationCmd}
                onChange={(e) => setNewValidationCmd(e.target.value)}
              />
            </div>

            <div className="flex items-center gap-2 pt-1">
              <Checkbox
                id="set-active"
                checked={setActiveImmediately}
                onCheckedChange={(checked) => setSetActiveImmediately(Boolean(checked))}
              />
              <label
                htmlFor="set-active"
                className="text-xs text-muted-foreground cursor-pointer select-none"
              >
                Establecer como meta activa inmediatamente
              </label>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={isSubmitting || !newTitle.trim()}>
              {isSubmitting ? <Loader2 className="size-4 animate-spin mr-1" /> : null}
              Crear objetivo
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
