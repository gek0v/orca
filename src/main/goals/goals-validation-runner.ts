import fs from 'node:fs/promises'
import path from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import type { GoalValidation } from '../../shared/goals/goals-schema'

export const DEFAULT_VALIDATION_TIMEOUT_MS = 300_000
const MAX_SUMMARY_LINES = 10
const MAX_SUMMARY_CHARS = 500

export type GoalValidationResult = GoalValidation & {
  lastRunAt: number
  exitCode: number
}

export type RunValidationOptions = {
  timeoutMs?: number
}

export function extractSummaryTail(stdout: string, stderr: string): string | undefined {
  const combined = [stdout, stderr].filter(Boolean).join('\n')
  const lines = combined
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)

  if (lines.length === 0) {
    return undefined
  }

  const lastLines = lines.slice(-MAX_SUMMARY_LINES)
  let tail = lastLines.join('\n')
  if (tail.length > MAX_SUMMARY_CHARS) {
    tail = tail.slice(-MAX_SUMMARY_CHARS)
  }
  return tail
}

export class GoalsValidationRunner {
  private activeRuns = new Map<string, AbortController>()

  public async runValidation(
    workspacePath: string,
    command: string,
    goalId?: string,
    options?: RunValidationOptions
  ): Promise<GoalValidationResult> {
    const runKey = goalId ? `${workspacePath}:${goalId}` : workspacePath

    const previousController = this.activeRuns.get(runKey)
    if (previousController) {
      previousController.abort()
    }

    const controller = new AbortController()
    this.activeRuns.set(runKey, controller)

    const isWindows = process.platform === 'win32'
    const program = isWindows ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh'
    const args = isWindows ? ['/d', '/s', '/c', command] : ['-c', command]
    const timeoutMs = options?.timeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS

    try {
      const result = await runProcess({
        program,
        args,
        cwd: workspacePath,
        timeoutMs,
        signal: controller.signal,
        terminationBarrier: true
      })

      if (controller.signal.aborted) {
        throw new Error('Validation was aborted by a newer run')
      }

      const fullOutput = [result.stdout, result.stderr].filter(Boolean).join('\n')
      const orcaDir = path.join(workspacePath, '.orca')
      await fs.mkdir(orcaDir, { recursive: true })
      await fs.writeFile(path.join(orcaDir, 'last_validation.log'), fullOutput, 'utf8')

      const success = !result.timedOut && result.code === 0
      const exitCode = result.code ?? (result.timedOut ? 124 : 1)
      const summaryTail = extractSummaryTail(result.stdout, result.stderr)

      return {
        command,
        status: success ? 'success' : 'failed',
        exitCode,
        summaryTail,
        lastRunAt: Date.now()
      }
    } finally {
      if (this.activeRuns.get(runKey) === controller) {
        this.activeRuns.delete(runKey)
      }
    }
  }

  public cancelValidation(workspacePath: string, goalId?: string): void {
    const runKey = goalId ? `${workspacePath}:${goalId}` : workspacePath
    const controller = this.activeRuns.get(runKey)
    if (controller) {
      controller.abort()
      this.activeRuns.delete(runKey)
    }
  }

  public dispose(): void {
    for (const controller of this.activeRuns.values()) {
      controller.abort()
    }
    this.activeRuns.clear()
  }
}
