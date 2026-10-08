import { forceTerminateProcessTree } from '../../shared/child-process/process-tree-termination'
import type { spawnProcess } from '../../shared/child-process/run-process'

export type TerminalExitState = {
  exitCode: number | null
  signal: string | null
}

export type TerminalOutputState = {
  output: string
  truncated: boolean
  exitStatus: TerminalExitState | null
}

export class AcpTerminalInstance {
  readonly terminalId: string
  readonly sessionId: string
  readonly child: ReturnType<typeof spawnProcess>
  private readonly chunks: Buffer[] = []
  private bufferedBytes = 0
  private readonly byteLimit: number
  private isTruncated = false
  private currentExitStatus: TerminalExitState | null = null
  private readonly waiters: ((status: TerminalExitState) => void)[] = []

  constructor(input: {
    terminalId: string
    sessionId: string
    child: ReturnType<typeof spawnProcess>
    byteLimit: number
  }) {
    this.terminalId = input.terminalId
    this.sessionId = input.sessionId
    this.child = input.child
    this.byteLimit = input.byteLimit
    this.attachProcessListeners()
  }

  get exitStatus(): TerminalExitState | null {
    return this.currentExitStatus
  }

  get truncated(): boolean {
    return this.isTruncated
  }

  getOutput(): TerminalOutputState {
    const output = Buffer.concat(this.chunks).toString('utf8')
    const exitStatus = this.currentExitStatus
      ? {
          exitCode: this.currentExitStatus.exitCode,
          signal: this.currentExitStatus.signal
        }
      : null

    return {
      output,
      truncated: this.isTruncated,
      exitStatus
    }
  }

  waitForExit(signal?: AbortSignal): Promise<TerminalExitState> {
    if (this.currentExitStatus !== null) {
      return Promise.resolve(this.currentExitStatus)
    }

    return new Promise<TerminalExitState>((resolve, reject) => {
      let onAbort: (() => void) | undefined

      const cleanup = (): void => {
        if (onAbort && signal) {
          signal.removeEventListener('abort', onAbort)
        }
      }

      const waiter = (status: TerminalExitState): void => {
        cleanup()
        resolve(status)
      }

      this.waiters.push(waiter)

      if (signal) {
        onAbort = () => {
          const idx = this.waiters.indexOf(waiter)
          if (idx !== -1) {
            this.waiters.splice(idx, 1)
          }
          const reason = signal.reason
          if (reason instanceof Error) {
            reject(reason)
          } else {
            reject(new Error('Request cancelled'))
          }
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  async kill(): Promise<void> {
    await forceTerminateProcessTree(this.child).catch(() => {})
  }

  async release(): Promise<void> {
    if (this.currentExitStatus === null) {
      await this.kill()
    }
  }

  private attachProcessListeners(): void {
    const { child } = this

    const appendChunk = (chunk: Buffer | string): void => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (this.bufferedBytes < this.byteLimit) {
        const remaining = this.byteLimit - this.bufferedBytes
        if (buf.length <= remaining) {
          this.chunks.push(buf)
          this.bufferedBytes += buf.length
        } else {
          this.chunks.push(buf.subarray(0, remaining))
          this.bufferedBytes += remaining
          this.isTruncated = true
        }
      } else if (buf.length > 0) {
        this.isTruncated = true
      }
    }

    child.stdout?.on('data', appendChunk)
    child.stderr?.on('data', appendChunk)
    child.stdout?.on('error', () => {})
    child.stderr?.on('error', () => {})
    child.stdin?.on('error', () => {})

    try {
      child.stdin?.end?.()
    } catch {
      // Mock streams may not implement end.
    }

    let settled = false
    let pendingCode: number | null = null
    let pendingSignal: string | null = null

    const settleExit = (code: number | null, signal: string | null): void => {
      if (settled) {
        return
      }
      settled = true

      const resolvedCode =
        code !== null && code !== undefined ? code : (child.exitCode ?? pendingCode ?? null)
      const resolvedSignal =
        signal !== null && signal !== undefined
          ? String(signal)
          : child.signalCode
            ? String(child.signalCode)
            : pendingSignal

      this.currentExitStatus = {
        exitCode: resolvedCode !== null && resolvedCode >= 0 ? resolvedCode : null,
        signal: resolvedSignal ?? null
      }

      for (const waiter of this.waiters) {
        waiter(this.currentExitStatus)
      }
      this.waiters.length = 0
    }

    child.on('error', () => {
      settleExit(null, null)
    })

    child.once('exit', (code, signal) => {
      pendingCode = code ?? null
      pendingSignal = signal ? String(signal) : null
      setImmediate(() => {
        settleExit(pendingCode, pendingSignal)
      })
    })

    child.once('close', (code, signal) => {
      settleExit(code ?? null, signal ? String(signal) : null)
    })
  }
}
