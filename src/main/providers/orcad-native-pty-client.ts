import * as net from 'node:net'
import * as readline from 'node:readline'
import { spawnProcess } from '@orca/process-host'

export type OrcadNativePtyClientOptions = {
  endpoint: string
  binaryPath: string | null
  spawnDaemonIfMissing: boolean
}

type OrcadIncomingMessage = {
  type?: string
  event?: string
  id?: string | number
  terminalId?: string | number
  data?: string
  code?: number
  status?: string
  result?: unknown
  error?: { message?: string }
}

type PendingRpcRequest = {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

export type OrcadStreamEvent =
  | { type: 'data'; terminalId: string; data: string }
  | { type: 'exit'; terminalId: string; code: number }

export class OrcadNativePtyClient {
  private endpoint: string
  private binaryPath: string | null
  private spawnDaemonIfMissing: boolean
  private daemonProcess: ReturnType<typeof spawnProcess> | null = null
  private socket: net.Socket | null = null
  private rl: readline.Interface | null = null
  private connectingPromise: Promise<void> | null = null
  private reqId = 0
  private pendingRequests = new Map<string, PendingRpcRequest>()
  private eventListeners = new Set<(event: OrcadStreamEvent) => void>()

  constructor(opts: OrcadNativePtyClientOptions) {
    this.endpoint = opts.endpoint
    this.binaryPath = opts.binaryPath
    this.spawnDaemonIfMissing = opts.spawnDaemonIfMissing
  }

  getEndpoint(): string {
    return this.endpoint
  }

  getDaemonPid(): number | null {
    return this.daemonProcess?.pid ?? null
  }

  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed
  }

  onEvent(listener: (event: OrcadStreamEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  async ensureConnected(): Promise<void> {
    if (this.isConnected()) {
      return
    }
    if (this.connectingPromise) {
      return this.connectingPromise
    }
    this.connectingPromise = this.connectInternal().finally(() => {
      this.connectingPromise = null
    })
    return this.connectingPromise
  }

  private async connectInternal(): Promise<void> {
    try {
      await this.tryOpenSocket()
      return
    } catch (err) {
      if (!this.spawnDaemonIfMissing || !this.binaryPath) {
        throw err
      }
    }

    this.spawnDaemon()

    let lastError: Error | null = null
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      try {
        await this.tryOpenSocket()
        return
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
      }
    }

    throw lastError ?? new Error(`Failed to connect to orcad daemon at ${this.endpoint}`)
  }

  private tryOpenSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(this.endpoint)
      let resolved = false

      sock.once('connect', () => {
        resolved = true
        this.socket = sock
        this.setupSocket(sock)
        resolve()
      })

      sock.once('error', (err) => {
        if (!resolved) {
          sock.destroy()
          reject(err)
        }
      })
    })
  }

  private spawnDaemon(): void {
    if (!this.binaryPath) {
      return
    }
    const args = [
      process.platform === 'win32' ? '--pipe' : '--socket',
      this.endpoint,
      '--idle-timeout',
      '0'
    ]
    this.daemonProcess = spawnProcess({
      program: this.binaryPath,
      args,
      detached: true,
      stdio: 'ignore'
    })
    this.daemonProcess.on('error', () => {
      /* Suppress unhandled error events on detached daemon handle */
    })
    this.daemonProcess.unref()
  }

  private setupSocket(sock: net.Socket): void {
    this.rl = readline.createInterface({ input: sock })

    this.rl.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) {
        return
      }
      try {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: JSON line parsed from orcad IPC protocol.
        const msg = JSON.parse(trimmed) as OrcadIncomingMessage

        if (msg.type === 'event' || msg.event) {
          const rawId = msg.id ?? msg.terminalId
          if (rawId === undefined || rawId === null) {
            return
          }
          const terminalId = String(rawId)
          if (msg.event === 'data' && msg.data !== undefined) {
            for (const listener of this.eventListeners) {
              listener({ type: 'data', terminalId, data: msg.data })
            }
          } else if (msg.event === 'exit') {
            const code = msg.code ?? 0
            for (const listener of this.eventListeners) {
              listener({ type: 'exit', terminalId, code })
            }
          }
        } else if (msg.id && this.pendingRequests.has(String(msg.id))) {
          const pending = this.pendingRequests.get(String(msg.id))!
          this.pendingRequests.delete(String(msg.id))
          if (msg.status === 'success' || (msg.result !== undefined && !msg.error)) {
            pending.resolve(msg.result)
          } else {
            pending.reject(new Error(msg.error?.message ?? 'RPC request failed'))
          }
        }
      } catch {
        /* Ignore malformed lines */
      }
    })

    sock.on('close', () => {
      sock.destroy()
      this.cleanupConnection()
    })

    sock.on('error', () => {
      sock.destroy()
      this.cleanupConnection()
    })
  }

  private cleanupConnection(): void {
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
    if (this.rl) {
      this.rl.close()
      this.rl = null
    }
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error('Connection to orcad closed'))
    }
    this.pendingRequests.clear()
  }

  async callRpc<T = unknown>(method: string, params?: unknown): Promise<T> {
    await this.ensureConnected()
    const id = `req_${++this.reqId}`
    const payload = `${JSON.stringify({ id, method, params })}\n`

    return new Promise<T>((resolve, reject) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Generic RPC response caller asserts expected result payload shape.
      this.pendingRequests.set(id, { resolve: resolve as (val: unknown) => void, reject })
      this.socket?.write(payload, (err) => {
        if (err) {
          this.pendingRequests.delete(id)
          reject(err)
        }
      })
    })
  }

  dispose(): void {
    this.cleanupConnection()
    if (this.daemonProcess) {
      try {
        this.daemonProcess.kill()
      } catch {
        /* Best-effort kill */
      }
      this.daemonProcess = null
    }
  }
}
