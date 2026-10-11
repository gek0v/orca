import { randomUUID } from 'node:crypto'
import { WRITE_ACCEPTED, type WriteSettlement } from '../../shared/pty-write-settlement'
import type {
  IPtyProvider,
  PtyDataEvent,
  PtyProcessInfo,
  PtySpawnOptions,
  PtySpawnResult
} from './types'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import type { TerminalOscColorQueryReplyColors } from '../../shared/terminal-osc-color-reply'
import type { DaemonEndpointIdentity } from '../daemon/daemon-hello-protocol'
import { resolveNativeBinary } from '../orcad/orcad-local-serve-selection'
import { OrcadNativePtyClient } from './orcad-native-pty-client'

export type OrcadNativePtyProviderOptions = {
  endpoint?: string
  binaryPath?: string
  spawnDaemonIfMissing?: boolean
}

type ActivePtyRecord = {
  id: string
  incarnationId: string
  pid: number | null
  cols: number
  rows: number
  cwd: string
}

export class OrcadNativePtyProvider implements IPtyProvider {
  private client: OrcadNativePtyClient
  private activePtys = new Map<string, ActivePtyRecord>()
  private dataListeners = new Set<(payload: PtyDataEvent) => void>()
  private exitListeners = new Set<
    (payload: {
      id: string
      code: number
      incarnationId?: string
      cause?: TerminalExitCause
    }) => void
  >()

  constructor(opts: OrcadNativePtyProviderOptions = {}) {
    const endpoint =
      opts.endpoint ??
      (process.platform === 'win32'
        ? `\\\\.\\pipe\\orcad-desktop-${process.pid}`
        : `/tmp/orcad-desktop-${process.pid}.sock`)
    const binaryPath =
      opts.binaryPath ??
      resolveNativeBinary({
        env: process.env,
        platform: process.platform,
        userDataPath: '',
        templateDirs: []
      })
    const spawnDaemonIfMissing = opts.spawnDaemonIfMissing ?? true

    this.client = new OrcadNativePtyClient({
      endpoint,
      binaryPath,
      spawnDaemonIfMissing
    })

    this.client.onEvent((event) => {
      if (event.type === 'data') {
        for (const listener of this.dataListeners) {
          listener({ id: event.terminalId, data: event.data })
        }
      } else if (event.type === 'exit') {
        const incarnationId = this.activePtys.get(event.terminalId)?.incarnationId
        this.activePtys.delete(event.terminalId)
        for (const listener of this.exitListeners) {
          listener({ id: event.terminalId, code: event.code, incarnationId })
        }
      }
    })
  }

  getEndpoint(): string {
    return this.client.getEndpoint()
  }

  isConnected(): boolean {
    return this.client.isConnected()
  }

  async ensureConnected(): Promise<void> {
    await this.client.ensureConnected()
  }

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    await this.client.ensureConnected()
    const defaultShell =
      process.platform === 'win32'
        ? process.env.COMSPEC || 'cmd.exe'
        : process.env.SHELL || '/bin/sh'
    const command = opts.shellOverride || opts.command || defaultShell
    const args = opts.terminalShellArgs || []

    const res = await this.client.callRpc<{
      id?: string | number
      terminalId?: string | number
      handle?: string | number
      pid?: number
    }>('terminal.create', {
      command,
      args,
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env
    })

    const rawId = res.id ?? res.terminalId ?? res.handle
    const id = rawId !== undefined && rawId !== null ? String(rawId) : `term-${randomUUID()}`
    const incarnationId = randomUUID()
    const pid = typeof res.pid === 'number' ? res.pid : null

    this.activePtys.set(id, {
      id,
      incarnationId,
      pid,
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd ?? ''
    })

    opts.onPtySpawnCommitted?.()

    return {
      id,
      incarnationId,
      pid,
      shellReadyArmed: false
    }
  }

  write(id: string, data: string): boolean {
    void this.client.callRpc('terminal.write', { id: Number(id) || id, data }).catch(() => {})
    return true
  }

  writeWithSettlement(id: string, data: string): Promise<WriteSettlement> {
    return this.client
      .callRpc('terminal.write', { id: Number(id) || id, data })
      .then(() => WRITE_ACCEPTED)
      .catch((err: Error) => ({
        outcome: 'refused',
        reason: 'transport_rejected_before_handoff',
        error: err
      }))
  }

  resize(id: string, cols: number, rows: number): void {
    const pty = this.activePtys.get(id)
    if (pty) {
      pty.cols = cols
      pty.rows = rows
    }
    void this.client
      .callRpc('terminal.resize', { id: Number(id) || id, cols, rows })
      .catch(() => {})
  }

  async shutdown(id: string): Promise<void> {
    this.activePtys.delete(id)
    try {
      await this.client.callRpc('terminal.shutdown', { id: Number(id) || id })
    } catch {
      /* Best-effort shutdown */
    }
  }

  pause(_id: string): void {}

  resume(_id: string): void {}

  setColorQueryReplyColors(_colors: TerminalOscColorQueryReplyColors): void {}

  attach(_id: string): Promise<void> {
    return Promise.resolve()
  }

  sendSignal(_id: string, _signal: string): Promise<void> {
    return Promise.resolve()
  }

  clearBuffer(_id: string): Promise<void> {
    return Promise.resolve()
  }

  resetInputModes(_id: string): Promise<void> {
    return Promise.resolve()
  }

  acknowledgeDataEvent(_id: string, _charCount: number): void {}

  hasChildProcesses(_id: string): Promise<boolean> {
    return Promise.resolve(true)
  }

  getForegroundProcess(_id: string): Promise<string | null> {
    return Promise.resolve(null)
  }

  serialize(_ids: string[]): Promise<string> {
    return Promise.resolve('')
  }

  revive(_state: string): Promise<void> {
    return Promise.resolve()
  }

  getDefaultShell(): Promise<string> {
    return Promise.resolve(
      process.platform === 'win32'
        ? process.env.COMSPEC || 'cmd.exe'
        : process.env.SHELL || '/bin/sh'
    )
  }

  getProfiles(): Promise<{ name: string; path: string }[]> {
    return Promise.resolve([])
  }

  probePtyLiveness(id: string): Promise<boolean | null> {
    return Promise.resolve(this.activePtys.has(id))
  }

  getInitialCwd(id: string): Promise<string> {
    return Promise.resolve(this.activePtys.get(id)?.cwd ?? '')
  }

  getCwd(id: string): Promise<string> {
    return Promise.resolve(this.activePtys.get(id)?.cwd ?? '')
  }

  async listProcesses(): Promise<PtyProcessInfo[]> {
    return Array.from(this.activePtys.values()).map((p) => ({
      id: p.id,
      incarnationId: p.incarnationId,
      rootProcessId: p.pid ?? undefined,
      cwd: p.cwd,
      title: ''
    }))
  }

  getAppliedSize(id: string): Promise<{ cols: number; rows: number } | null> {
    const pty = this.activePtys.get(id)
    return Promise.resolve(pty ? { cols: pty.cols, rows: pty.rows } : null)
  }

  onData(callback: (payload: PtyDataEvent) => void): () => void {
    this.dataListeners.add(callback)
    return () => {
      this.dataListeners.delete(callback)
    }
  }

  onReplay(_callback: (payload: { id: string; data: string }) => void): () => void {
    return () => {}
  }

  onExit(
    callback: (payload: {
      id: string
      code: number
      incarnationId?: string
      cause?: TerminalExitCause
    }) => void
  ): () => void {
    this.exitListeners.add(callback)
    return () => {
      this.exitListeners.delete(callback)
    }
  }

  getActiveSessionIds(): string[] {
    return Array.from(this.activePtys.keys())
  }

  fanoutSyntheticExits(code: number): void {
    for (const [id, pty] of this.activePtys) {
      for (const listener of this.exitListeners) {
        listener({ id, code, incarnationId: pty.incarnationId })
      }
    }
  }

  async disconnectOnly(): Promise<void> {
    this.dispose()
  }

  requestIdleRetirement(): Promise<{ state: 'unverifiable' }> {
    return Promise.resolve({ state: 'unverifiable' })
  }

  releaseIdleRetirementFence(): void {}

  getDaemonIdentity(): DaemonEndpointIdentity {
    return {
      pid: this.client.getDaemonPid() ?? process.pid,
      startedAtMs: Date.now(),
      launchNonce: 'orcad-native'
    }
  }

  dispose(): void {
    this.client.dispose()
  }
}
