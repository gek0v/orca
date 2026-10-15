import { randomUUID } from 'node:crypto'
import {
  WRITE_ACCEPTED,
  writeRefused,
  type WriteSettlement
} from '../../shared/pty-write-settlement'
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
import { buildOrcadPtySpawnPlan } from './orcad-pty-spawn-plan'
import { resolveNativeBinary } from '../orcad/orcad-local-serve-selection'
import { OrcadNativePtyClient } from './orcad-native-pty-client'
import { SessionNotFoundError } from '../daemon/daemon-errors'
import type { OrcadNativePtyProviderOptions } from './orcad-native-pty-types'
import { OrcadNativePtyState } from './orcad-native-pty-state'

export type { OrcadNativePtyProviderOptions } from './orcad-native-pty-types'

export class OrcadNativePtyProvider implements IPtyProvider {
  readonly isOrcadNative = true
  private client: OrcadNativePtyClient
  private state = new OrcadNativePtyState()
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
      }) ??
      undefined
    const spawnDaemonIfMissing = opts.spawnDaemonIfMissing ?? true

    this.client = new OrcadNativePtyClient({
      endpoint,
      binaryPath: binaryPath ?? null,
      spawnDaemonIfMissing
    })

    this.client.onEvent((event) => {
      if (event.type === 'data') {
        for (const listener of this.dataListeners) {
          listener({ id: event.terminalId, data: event.data })
        }
      } else if (event.type === 'exit') {
        const incarnationId = this.state.get(event.terminalId)?.incarnationId
        this.state.delete(event.terminalId)
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

    if (opts.attachOnly) {
      const existing = opts.sessionId ? this.state.get(opts.sessionId) : undefined
      if (existing) {
        return {
          id: existing.id,
          incarnationId: existing.incarnationId,
          pid: existing.pid,
          isReattach: true,
          shellReadyArmed: false
        }
      }
      throw new SessionNotFoundError(opts.sessionId ?? '')
    }

    const requestedId = opts.sessionId
    const plan = buildOrcadPtySpawnPlan(opts)
    const res = await this.client.callRpc<{
      id?: string | number
      terminalId?: string | number
      handle?: string | number
      pid?: number
    }>('pty.spawn', {
      id: requestedId,
      terminalId: requestedId,
      sessionId: requestedId,
      command: plan.command,
      args: plan.args,
      cols: opts.cols,
      rows: opts.rows,
      cwd: plan.cwd,
      env: plan.env
    })

    const rawId = requestedId ?? res.id ?? res.terminalId ?? res.handle
    const id = rawId !== undefined && rawId !== null ? String(rawId) : `term-${randomUUID()}`
    const incarnationId = randomUUID()
    const pid = typeof res.pid === 'number' ? res.pid : null

    this.state.set(id, {
      id,
      incarnationId,
      pid,
      cols: opts.cols,
      rows: opts.rows,
      cwd: plan.cwd,
      command: opts.command,
      launchAgent: opts.launchAgent
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
    void this.client
      .callRpc('pty.write', { id: String(id), terminalId: String(id), data })
      .catch(() => {})
    return true
  }

  writeWithSettlement(id: string, data: string): Promise<WriteSettlement> {
    return this.client
      .callRpc('pty.write', { id: String(id), terminalId: String(id), data })
      .then(() => WRITE_ACCEPTED)
      .catch(() => writeRefused('transport_rejected_before_handoff'))
  }

  resize(id: string, cols: number, rows: number): void {
    this.state.updateDimensions(id, cols, rows)
    void this.client
      .callRpc('pty.resize', { id: String(id), terminalId: String(id), cols, rows })
      .catch(() => {})
  }

  pauseProducer(id: string): void {
    void this.client.callRpc('pausePty', { id: String(id), terminalId: String(id) }).catch(() => {})
  }

  resumeProducer(id: string): void {
    void this.client
      .callRpc('resumePty', { id: String(id), terminalId: String(id) })
      .catch(() => {})
  }

  pause(id: string): void {
    this.pauseProducer(id)
  }

  resume(id: string): void {
    this.resumeProducer(id)
  }

  setPtyBackgrounded(id: string, background: boolean): void {
    void this.client
      .callRpc('setSessionBackground', { id: String(id), terminalId: String(id), background })
      .catch(() => {})
  }

  async shutdown(
    id: string,
    _opts?: {
      immediate?: boolean
      keepHistory?: boolean
      deadlineMs?: number
      expectedIncarnationId?: string
      expectedOwnerClientInstanceId?: string
    }
  ): Promise<void> {
    this.state.delete(id)
    try {
      await this.client.callRpc('pty.shutdown', { id: String(id), terminalId: String(id) })
    } catch {
      /* Best-effort shutdown */
    }
  }

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

  getForegroundProcess(id: string): Promise<string | null> {
    return Promise.resolve(this.state.getForegroundProcess(id))
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

  hasPty(id: string): boolean {
    return this.state.has(id)
  }

  probePtyLiveness(id: string): Promise<boolean | null> {
    return Promise.resolve(this.state.has(id))
  }

  getInitialCwd(id: string): Promise<string> {
    return Promise.resolve(this.state.getCwd(id))
  }

  getCwd(id: string): Promise<string> {
    return Promise.resolve(this.state.getCwd(id))
  }

  async listProcesses(): Promise<PtyProcessInfo[]> {
    return this.state.listProcesses()
  }

  getAppliedSize(id: string): Promise<{ cols: number; rows: number } | null> {
    return Promise.resolve(this.state.getAppliedSize(id))
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
    return this.state.getActiveSessionIds()
  }

  fanoutSyntheticExits(code: number): void {
    for (const [id, pty] of this.state.entries()) {
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
