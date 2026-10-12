import { existsSync, type FSWatcher, watch } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  type WorkspaceGoalsData,
  type Goal,
  type GoalStatus,
  WorkspaceGoalsDataSchema
} from '../../shared/goals/goals-schema'
import {
  getOrcaDirectoryPath,
  getGoalsJsonPath,
  getCurrentGoalMarkdownPath,
  ensureGitExclusion
} from './worktree-goals-path'

const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
  pending: 'Pendiente',
  in_progress: 'En curso',
  in_verification: 'En verificación',
  completed: 'Completado',
  failed: 'Fallido'
}

const AGENT_RULES_FOOTER = `---
> ⚠️ **REGLA PARA EL AGENTE:** NO modifiques manualmente el archivo .orca/goals.json.
> Para marcar tareas completadas ejecuta: \`orca goal complete <id-o-índice>\`.
> Para añadir nuevas tareas ejecuta: \`orca goal add-task "<título>"\`.
> Para validar el objetivo ejecuta: \`orca goal validate\`.`

export class WorktreeGoalsService {
  private queue: Promise<unknown> = Promise.resolve()
  private lastWrittenContentHash: string | null = null
  private cachedData: WorkspaceGoalsData | null = null
  private watcher: FSWatcher | null = null
  private readonly listeners = new Set<(data: WorkspaceGoalsData) => void>()
  private disposed = false

  constructor(readonly workspacePath: string) {}

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task)
    this.queue = result.catch(() => {})
    return result
  }

  async ensureGitExclusion(): Promise<void> {
    await ensureGitExclusion(this.workspacePath)
  }

  async loadGoals(): Promise<WorkspaceGoalsData> {
    return this.enqueue(async () => {
      const goalsJsonPath = getGoalsJsonPath(this.workspacePath)

      if (!existsSync(goalsJsonPath)) {
        const defaultData: WorkspaceGoalsData = { activeGoalId: null, goals: [] }
        await this.writeGoalsToDisk(defaultData)
        return defaultData
      }

      const content = await fs.readFile(goalsJsonPath, 'utf8')
      this.lastWrittenContentHash = createHash('sha256').update(content).digest('hex')
      const parsed = JSON.parse(content)
      const data = WorkspaceGoalsDataSchema.parse(parsed)
      this.cachedData = data
      this.ensureWatcher()
      return data
    })
  }

  async saveGoals(data: WorkspaceGoalsData): Promise<void> {
    const validated = WorkspaceGoalsDataSchema.parse(data)
    await this.enqueue(async () => {
      await this.writeGoalsToDisk(validated)
    })
  }

  async updateGoals(
    updater: (current: WorkspaceGoalsData) => WorkspaceGoalsData | Promise<WorkspaceGoalsData>
  ): Promise<WorkspaceGoalsData> {
    return this.enqueue(async () => {
      const current = this.cachedData ?? (await this.loadGoalsInternal())
      const updated = await updater(current)
      const validated = WorkspaceGoalsDataSchema.parse(updated)
      await this.writeGoalsToDisk(validated)
      return validated
    })
  }

  onExternalChange(callback: (data: WorkspaceGoalsData) => void): () => void {
    this.listeners.add(callback)
    this.ensureWatcher()
    return () => {
      this.listeners.delete(callback)
    }
  }

  async projectCurrentGoalFile(): Promise<void> {
    const currentData = this.cachedData ?? (await this.loadGoalsInternal())
    const activeGoal = currentData.activeGoalId
      ? (currentData.goals.find((g) => g.id === currentData.activeGoalId) ?? null)
      : null

    const markdown = this.renderMarkdownProjection(activeGoal)
    const mdPath = getCurrentGoalMarkdownPath(this.workspacePath)
    const orcaDir = getOrcaDirectoryPath(this.workspacePath)

    await fs.mkdir(orcaDir, { recursive: true })
    await fs.writeFile(mdPath, markdown, 'utf8')
  }

  dispose(): void {
    this.disposed = true
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    this.listeners.clear()
  }

  private async loadGoalsInternal(): Promise<WorkspaceGoalsData> {
    const goalsJsonPath = getGoalsJsonPath(this.workspacePath)
    if (!existsSync(goalsJsonPath)) {
      const defaultData: WorkspaceGoalsData = { activeGoalId: null, goals: [] }
      await this.writeGoalsToDisk(defaultData)
      return defaultData
    }
    const content = await fs.readFile(goalsJsonPath, 'utf8')
    this.lastWrittenContentHash = createHash('sha256').update(content).digest('hex')
    const parsed = JSON.parse(content)
    const data = WorkspaceGoalsDataSchema.parse(parsed)
    this.cachedData = data
    return data
  }

  private async writeGoalsToDisk(data: WorkspaceGoalsData): Promise<void> {
    const orcaDir = getOrcaDirectoryPath(this.workspacePath)
    await fs.mkdir(orcaDir, { recursive: true })
    await this.ensureGitExclusion()

    const content = `${JSON.stringify(data, null, 2)}\n`
    this.lastWrittenContentHash = createHash('sha256').update(content).digest('hex')
    this.cachedData = data

    const tmpPath = path.join(orcaDir, 'goals.json.tmp')
    const targetPath = getGoalsJsonPath(this.workspacePath)

    await fs.writeFile(tmpPath, content, 'utf8')
    await fs.rename(tmpPath, targetPath)

    await this.projectCurrentGoalFile()
    this.ensureWatcher()
  }

  private ensureWatcher(): void {
    if (this.watcher || this.disposed) {
      return
    }

    const orcaDir = getOrcaDirectoryPath(this.workspacePath)
    if (!existsSync(orcaDir)) {
      return
    }

    try {
      this.watcher = watch(orcaDir, (_eventType, filename) => {
        if (this.disposed) {
          return
        }
        if (filename && filename !== 'goals.json') {
          return
        }
        void this.handleFileWatcherEvent()
      })
      if (typeof this.watcher.unref === 'function') {
        this.watcher.unref()
      }
    } catch {
      // Directory watch failed or not supported in environment
    }
  }

  private async handleFileWatcherEvent(): Promise<void> {
    const goalsJsonPath = getGoalsJsonPath(this.workspacePath)
    try {
      const content = await fs.readFile(goalsJsonPath, 'utf8')
      const hash = createHash('sha256').update(content).digest('hex')
      if (hash === this.lastWrittenContentHash) {
        return
      }

      this.lastWrittenContentHash = hash
      const parsed = JSON.parse(content)
      const result = WorkspaceGoalsDataSchema.safeParse(parsed)
      if (result.success) {
        this.cachedData = result.data
        await this.projectCurrentGoalFile()
        for (const listener of this.listeners) {
          listener(result.data)
        }
      }
    } catch {
      // File may be temporarily unavailable or malformed during write.
    }
  }

  private renderMarkdownProjection(activeGoal: Goal | null): string {
    if (!activeGoal) {
      return [
        '# Ningún Objetivo Activo',
        'No hay ningún objetivo activo seleccionado actualmente en este espacio de trabajo.',
        '',
        AGENT_RULES_FOOTER,
        ''
      ].join('\n')
    }

    const sections: string[] = [
      `# Objetivo Activo: ${activeGoal.title}`,
      `**Estado:** ${GOAL_STATUS_LABELS[activeGoal.status] ?? activeGoal.status}`,
      `**ID:** ${activeGoal.id}`,
      '',
      '## Descripción',
      activeGoal.description?.trim() ? activeGoal.description.trim() : 'Sin descripción',
      '',
      '## Subtareas'
    ]

    if (activeGoal.subtasks.length === 0) {
      sections.push('*(No hay subtareas definidas)*')
    } else {
      activeGoal.subtasks.forEach((task, index) => {
        const marker = task.completed ? '- [x]' : '- [ ]'
        const workerSuffix = task.worker
          ? ` *(Worker: ${task.worker.agent} [${task.worker.status}])*`
          : ''
        sections.push(`${marker} ${index + 1}. ${task.title}${workerSuffix}`)
      })
    }

    if (activeGoal.validation) {
      sections.push('')
      sections.push('## Validación Técnica')
      sections.push(`- Comando: \`${activeGoal.validation.command}\``)

      const statusText =
        activeGoal.validation.status === 'failed' && activeGoal.validation.exitCode !== undefined
          ? `Fallido (exit code: ${activeGoal.validation.exitCode})`
          : activeGoal.validation.status === 'success'
            ? 'Exitoso'
            : activeGoal.validation.status === 'running'
              ? 'Ejecutando'
              : 'Inactivo'

      sections.push(`- Estado: ${statusText}`)

      if (activeGoal.validation.summaryTail) {
        // Bound validation summary to last 10 lines to protect agent context.
        const tailLines = activeGoal.validation.summaryTail
          .trim()
          .split(/\r?\n/)
          .slice(-10)
          .join('\n')
        sections.push('- Resumen del error (últimas líneas):')
        sections.push('```text')
        sections.push(tailLines)
        sections.push('```')
      }
      sections.push(
        '*(Log completo disponible en `.orca/last_validation.log` si se requiere depuración detallada)*'
      )
    }

    sections.push('')
    sections.push(AGENT_RULES_FOOTER)
    sections.push('')

    return sections.join('\n')
  }
}
