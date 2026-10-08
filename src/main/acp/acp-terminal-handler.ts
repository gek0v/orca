import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { spawnProcess } from '../../shared/child-process/run-process'
import type { ProcessSpec } from '../../shared/child-process/run-process'
import { AcpRpcError } from './acp-errors'
import type { AcpRequestContext } from './acp-json-rpc-peer'
import { AcpTerminalInstance } from './acp-terminal-instance'
import {
  CreateTerminalRequestSchema,
  CreateTerminalResponseSchema,
  type CreateTerminalResponse,
  KillTerminalRequestSchema,
  KillTerminalResponseSchema,
  type KillTerminalResponse,
  ReleaseTerminalRequestSchema,
  ReleaseTerminalResponseSchema,
  type ReleaseTerminalResponse,
  TerminalOutputRequestSchema,
  TerminalOutputResponseSchema,
  type TerminalOutputResponse,
  WaitForTerminalExitRequestSchema,
  WaitForTerminalExitResponseSchema,
  type WaitForTerminalExitResponse
} from './generated/acp-protocol.generated'

export type AcpCwdResolver = string | ((sessionId?: string) => string)

const DEFAULT_OUTPUT_BYTE_LIMIT = 2 * 1024 * 1024

export class AcpTerminalHandler {
  private readonly terminals = new Map<string, AcpTerminalInstance>()

  constructor(
    private readonly defaultCwd: AcpCwdResolver,
    private readonly spawnImpl: typeof spawnProcess = spawnProcess
  ) {}

  async handleRequest(
    method: 'terminal/create',
    params: unknown,
    context?: AcpRequestContext
  ): Promise<CreateTerminalResponse>
  async handleRequest(
    method: 'terminal/output',
    params: unknown,
    context?: AcpRequestContext
  ): Promise<TerminalOutputResponse>
  async handleRequest(
    method: 'terminal/wait_for_exit',
    params: unknown,
    context?: AcpRequestContext
  ): Promise<WaitForTerminalExitResponse>
  async handleRequest(
    method: 'terminal/kill',
    params: unknown,
    context?: AcpRequestContext
  ): Promise<KillTerminalResponse>
  async handleRequest(
    method: 'terminal/release',
    params: unknown,
    context?: AcpRequestContext
  ): Promise<ReleaseTerminalResponse>
  async handleRequest(
    method: string,
    params: unknown,
    context?: AcpRequestContext
  ): Promise<unknown>
  async handleRequest(
    method: string,
    params: unknown,
    context?: AcpRequestContext
  ): Promise<unknown> {
    switch (method) {
      case 'terminal/create':
        return this.handleCreateTerminal(params)
      case 'terminal/output':
        return this.handleTerminalOutput(params)
      case 'terminal/wait_for_exit':
        return this.handleWaitForTerminalExit(params, context)
      case 'terminal/kill':
        return this.handleKillTerminal(params)
      case 'terminal/release':
        return this.handleReleaseTerminal(params)
      default:
        throw new AcpRpcError(-32601, `Method not found: ${method}`)
    }
  }

  async releaseSessionTerminals(sessionId: string): Promise<void> {
    const toRelease: AcpTerminalInstance[] = []
    for (const terminal of this.terminals.values()) {
      if (terminal.sessionId === sessionId) {
        toRelease.push(terminal)
      }
    }
    await Promise.all(
      toRelease.map(async (terminal) => {
        await terminal.kill()
        this.terminals.delete(terminal.terminalId)
      })
    )
  }

  getTerminalCount(): number {
    return this.terminals.size
  }

  private handleCreateTerminal(params: unknown): CreateTerminalResponse {
    const parsed = CreateTerminalRequestSchema.safeParse(params)
    if (!parsed.success) {
      throw new AcpRpcError(-32602, parsed.error.message)
    }

    const { sessionId, command, args, cwd, env, outputByteLimit } = parsed.data
    const baseCwd = this.resolveCwd(sessionId)
    const resolvedCwd = cwd ? (path.isAbsolute(cwd) ? cwd : path.resolve(baseCwd, cwd)) : baseCwd
    const byteLimit =
      outputByteLimit !== undefined && outputByteLimit !== null
        ? outputByteLimit
        : DEFAULT_OUTPUT_BYTE_LIMIT

    const mergedEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) {
        mergedEnv[k] = v
      }
    }
    if (env) {
      for (const item of env) {
        mergedEnv[item.name] = item.value
      }
    }

    const spec: ProcessSpec = {
      program: command,
      args: args ?? [],
      cwd: resolvedCwd,
      env: mergedEnv
    }

    let child: ReturnType<typeof spawnProcess>
    try {
      child = this.spawnImpl(spec)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new AcpRpcError(-32603, message)
    }

    const terminalId = `term-${randomUUID()}`
    const terminal = new AcpTerminalInstance({
      terminalId,
      sessionId,
      child,
      byteLimit
    })

    this.terminals.set(terminalId, terminal)
    return CreateTerminalResponseSchema.parse({ terminalId })
  }

  private handleTerminalOutput(params: unknown): TerminalOutputResponse {
    const parsed = TerminalOutputRequestSchema.safeParse(params)
    if (!parsed.success) {
      throw new AcpRpcError(-32602, parsed.error.message)
    }

    const { sessionId, terminalId } = parsed.data
    const terminal = this.getTerminal(sessionId, terminalId)
    const outputState = terminal.getOutput()

    return TerminalOutputResponseSchema.parse(outputState)
  }

  private async handleWaitForTerminalExit(
    params: unknown,
    context?: AcpRequestContext
  ): Promise<WaitForTerminalExitResponse> {
    const parsed = WaitForTerminalExitRequestSchema.safeParse(params)
    if (!parsed.success) {
      throw new AcpRpcError(-32602, parsed.error.message)
    }

    const { sessionId, terminalId } = parsed.data
    const terminal = this.getTerminal(sessionId, terminalId)

    if (context?.signal?.aborted) {
      const reason = context.signal.reason
      if (reason instanceof Error) {
        throw reason
      }
      throw new AcpRpcError(-32800, 'Request cancelled')
    }

    try {
      const status = await terminal.waitForExit(context?.signal)
      return WaitForTerminalExitResponseSchema.parse({
        exitCode: status.exitCode,
        signal: status.signal
      })
    } catch (error) {
      if (error instanceof AcpRpcError) {
        throw error
      }
      if (error instanceof Error && error.message === 'Request cancelled') {
        throw new AcpRpcError(-32800, 'Request cancelled')
      }
      throw error
    }
  }

  private async handleKillTerminal(params: unknown): Promise<KillTerminalResponse> {
    const parsed = KillTerminalRequestSchema.safeParse(params)
    if (!parsed.success) {
      throw new AcpRpcError(-32602, parsed.error.message)
    }

    const { sessionId, terminalId } = parsed.data
    const terminal = this.getTerminal(sessionId, terminalId)

    await terminal.kill()
    return KillTerminalResponseSchema.parse({})
  }

  private async handleReleaseTerminal(params: unknown): Promise<ReleaseTerminalResponse> {
    const parsed = ReleaseTerminalRequestSchema.safeParse(params)
    if (!parsed.success) {
      throw new AcpRpcError(-32602, parsed.error.message)
    }

    const { sessionId, terminalId } = parsed.data
    const terminal = this.getTerminal(sessionId, terminalId)

    await terminal.release()
    this.terminals.delete(terminalId)

    return ReleaseTerminalResponseSchema.parse({})
  }

  private getTerminal(sessionId: string, terminalId: string): AcpTerminalInstance {
    const terminal = this.terminals.get(terminalId)
    if (!terminal || terminal.sessionId !== sessionId) {
      throw new AcpRpcError(-32602, `Terminal not found: ${terminalId}`)
    }
    return terminal
  }

  private resolveCwd(sessionId?: string): string {
    if (typeof this.defaultCwd === 'function') {
      return this.defaultCwd(sessionId)
    }
    return this.defaultCwd
  }
}
