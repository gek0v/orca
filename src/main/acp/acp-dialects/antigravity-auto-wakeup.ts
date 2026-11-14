import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AcpStructuredChild } from '../session/children/acp-structured-child'

const DEBOUNCE_MS = 600

export class AntigravityAutoWakeupWatcher {
  private watcher?: FSWatcher
  private lastSize = 0
  private debounceTimer?: NodeJS.Timeout
  private disposed = false

  constructor(
    private readonly session: AcpStructuredChild,
    private readonly customTranscriptPath?: string
  ) {}

  private get transcriptPath(): string {
    return (
      this.customTranscriptPath ??
      join(
        homedir(),
        '.gemini',
        'antigravity-cli',
        'brain',
        this.session.sessionId,
        '.system_generated',
        'logs',
        'transcript.jsonl'
      )
    )
  }

  async start(): Promise<void> {
    if (this.disposed || this.watcher) {
      return
    }

    try {
      const stats = await stat(this.transcriptPath)
      this.lastSize = stats.size
    } catch {
      this.lastSize = 0
    }

    try {
      this.watcher = watch(this.transcriptPath, () => {
        this.onFileChanged()
      })
      this.watcher.on('error', () => {
        // Silently tolerate watcher errors (e.g. file recreations)
      })
    } catch {
      // If the file does not exist yet, we will retry on subsequent idle checks
    }
  }

  private onFileChanged(): void {
    if (this.disposed) {
      return
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = setTimeout(() => {
      void this.checkAndWakeup()
    }, DEBOUNCE_MS)
  }

  async checkAndWakeup(): Promise<boolean> {
    if (this.disposed) {
      return false
    }

    try {
      const stats = await stat(this.transcriptPath)
      if (stats.size > this.lastSize) {
        this.lastSize = stats.size

        const turns = this.session.turns
        if (turns && !turns.running && !this.session.ended && !this.session.closeRequested) {
          turns.dispatch({
            clientMessageId: `antigravity-wakeup:${Date.now()}`,
            prompt: [{ type: 'text', text: ' ' }],
            requestedAt: Date.now()
          })
          return true
        }
      }
    } catch {
      // Ignore transient stat errors
    }
    return false
  }

  dispose(): void {
    this.disposed = true
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = undefined
    }
    if (this.watcher) {
      this.watcher.close()
      this.watcher = undefined
    }
  }
}
