import {
  GOALS_IPC_CHANNELS,
  type GoalsAssignWorkerRequest,
  type GoalsGenerateAiRequest,
  type GoalsGenerateAiResponse
} from '../../shared/goals/goals-ipc'
import type { GoalSubtaskWorker } from '../../shared/goals/goals-schema'
import { parseGoalAiResponse } from '../../shared/goals/goals-ai'
import { applyAssignWorker } from './goals-state-transitions'
import type { GoalsIpcTarget, GoalsManagerTarget } from './goals-ipc-handlers'

export function generateStructuredGoalDraft(prompt: string): GoalsGenerateAiResponse {
  const trimmed = prompt.trim()
  const lower = trimmed.toLowerCase()

  // High quality heuristic domain breakdown
  const subtasks: string[] = []
  let validationCommand = 'pnpm test'

  if (lower.includes('auth') || lower.includes('login') || lower.includes('oauth')) {
    subtasks.push('Configurar rutas y endpoints de autenticación')
    subtasks.push('Implementar persistencia segura de tokens y sesiones')
    subtasks.push('Integrar middleware de autorización y control de acceso')
    subtasks.push('Añadir tests unitarios y de integración para el flujo de autenticación')
    validationCommand = 'pnpm test src/auth/'
  } else if (lower.includes('api') || lower.includes('endpoint') || lower.includes('backend')) {
    subtasks.push('Diseñar especificación de contratos y esquemas de validación')
    subtasks.push('Implementar handlers y controladores de la API')
    subtasks.push('Conectar capa de persistencia y base de datos')
    subtasks.push('Añadir tests automatizados de endpoints y manejo de errores')
    validationCommand = 'pnpm test'
  } else if (
    lower.includes('ui') ||
    lower.includes('component') ||
    lower.includes('vista') ||
    lower.includes('diseño')
  ) {
    subtasks.push('Diseñar layout y componentes visuales accesibles')
    subtasks.push('Conectar estado global y reactividad de la interfaz')
    subtasks.push('Adaptar estilos al sistema de diseño y tokens')
    subtasks.push('Añadir tests de componentes e interacciones de usuario')
    validationCommand = 'pnpm test src/renderer/'
  } else {
    subtasks.push(`Analizar requisitos y alcance de: ${trimmed}`)
    subtasks.push('Implementar lógica principal y cambios de código')
    subtasks.push('Integrar y verificar compatibilidad en el proyecto')
    subtasks.push('Escribir tests unitarios y validar la solución')
  }

  // Capitalize title
  const title = trimmed.charAt(0).toUpperCase() + trimmed.slice(1)

  return parseGoalAiResponse(
    JSON.stringify({
      title,
      description: `Objetivo generado asistido por IA para: ${trimmed}`,
      subtasks,
      validationCommand
    }),
    trimmed
  )
}

export function registerGoalsAiAndWorkerIpcHandlers(
  ipcMain: GoalsIpcTarget,
  manager: GoalsManagerTarget
): () => void {
  ipcMain.handle(
    GOALS_IPC_CHANNELS.GENERATE_AI,
    async (_event: unknown, ...args: unknown[]): Promise<GoalsGenerateAiResponse> => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: IPC payload shape
      const req = (args[0] ?? {}) as GoalsGenerateAiRequest
      if (!req.prompt || typeof req.prompt !== 'string') {
        throw new Error('Prompt is required for AI goal generation')
      }
      return generateStructuredGoalDraft(req.prompt)
    }
  )

  ipcMain.handle(
    GOALS_IPC_CHANNELS.ASSIGN_WORKER,
    async (_event: unknown, ...args: unknown[]): Promise<void> => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: IPC payload shape
      const req = (args[0] ?? {}) as GoalsAssignWorkerRequest
      if (!req.workspacePath || !req.goalId || !req.subtaskId || !req.agent) {
        throw new Error('workspacePath, goalId, subtaskId, and agent are required')
      }

      const service = manager.getService(req.workspacePath)
      const worker: GoalSubtaskWorker = {
        workerId: req.workerId || `worker-${Date.now()}`,
        agent: req.agent,
        status: 'running',
        assignedAt: Date.now()
      }

      await service.updateGoals((current) =>
        applyAssignWorker(current, req.goalId, req.subtaskId, worker)
      )
    }
  )

  return () => {
    ipcMain.removeHandler(GOALS_IPC_CHANNELS.GENERATE_AI)
    ipcMain.removeHandler(GOALS_IPC_CHANNELS.ASSIGN_WORKER)
  }
}
