import * as net from 'node:net'
import * as readline from 'node:readline'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WRITE_ACCEPTED, writeRefused } from '../../shared/pty-write-settlement'
import { SessionNotFoundError } from '../daemon/daemon-errors'
import { OrcadNativePtyProvider } from './orcad-native-pty-provider'

describe('OrcadNativePtyProvider', () => {
  let server: net.Server
  let pipePath: string
  let clientSocket: net.Socket | null = null

  beforeEach(async () => {
    const id = Math.random().toString(36).slice(2)
    pipePath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\orcad-test-${process.pid}-${id}`
        : `/tmp/orcad-test-${process.pid}-${id}.sock`

    await new Promise<void>((resolve, reject) => {
      server = net.createServer((socket) => {
        clientSocket = socket
        const rl = readline.createInterface({ input: socket })
        rl.on('line', (line) => {
          if (!line.trim()) {
            return
          }
          try {
            const req = JSON.parse(line)
            if (req.method === 'ping') {
              socket.write(
                `${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true } })}\n`
              )
            } else if (req.method === 'terminal.create' || req.method === 'pty.spawn') {
              socket.write(
                `${JSON.stringify({
                  jsonrpc: '2.0',
                  id: req.id,
                  result: { ok: true, id: 1, pid: 4242 }
                })}\n`
              )
            } else if (
              req.method === 'terminal.write' ||
              req.method === 'terminal.input' ||
              req.method === 'pty.write'
            ) {
              if (req.params?.id === 'dead' || req.params?.terminalId === 'dead') {
                socket.write(
                  `${JSON.stringify({
                    jsonrpc: '2.0',
                    id: req.id,
                    error: { message: 'Terminal not found: dead' }
                  })}\n`
                )
              } else {
                socket.write(
                  `${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true } })}\n`
                )
              }
            } else if (req.method === 'terminal.resize' || req.method === 'pty.resize') {
              socket.write(
                `${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true } })}\n`
              )
            } else if (
              req.method === 'terminal.kill' ||
              req.method === 'terminal.shutdown' ||
              req.method === 'pty.shutdown'
            ) {
              socket.write(
                `${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true } })}\n`
              )
            } else if (req.method === 'terminal.pausePty' || req.method === 'pausePty') {
              socket.write(
                `${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true, paused: true } })}\n`
              )
            } else if (req.method === 'terminal.resumePty' || req.method === 'resumePty') {
              socket.write(
                `${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true, paused: false } })}\n`
              )
            } else if (req.method === 'status.list') {
              socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: [] })}\n`)
            }
          } catch {
            /* ignore bad json */
          }
        })
      })
      server.listen(pipePath, () => resolve())
      server.on('error', reject)
    })
  })

  afterEach(async () => {
    if (clientSocket) {
      clientSocket.destroy()
      clientSocket = null
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  })

  it('connects to orcad endpoint and performs ping/spawn/write/resize/pause/shutdown lifecycle', async () => {
    const provider = new OrcadNativePtyProvider({
      endpoint: pipePath,
      spawnDaemonIfMissing: false
    })

    await provider.ensureConnected()
    expect(provider.isConnected()).toBe(true)

    // Spawn terminal
    const spawnRes = await provider.spawn({
      command: 'cmd.exe',
      cols: 80,
      rows: 24,
      cwd: process.cwd()
    })
    expect(spawnRes.id).toBe('1')
    expect(spawnRes.pid).toBe(4242)

    // Write input
    const writeOk = provider.write('1', 'echo hello\r\n')
    expect(writeOk).toBe(true)

    // Resize
    provider.resize('1', 120, 30)
    const applied = await provider.getAppliedSize('1')
    expect(applied).toEqual({ cols: 120, rows: 30 })

    // Pause / resume flow control
    provider.pauseProducer('1')
    provider.resumeProducer('1')

    // Shutdown
    await provider.shutdown('1')
    provider.dispose()
    expect(provider.isConnected()).toBe(false)
  })

  it('receives streaming data and exit events from orcad daemon', async () => {
    const provider = new OrcadNativePtyProvider({
      endpoint: pipePath,
      spawnDaemonIfMissing: false
    })

    await provider.ensureConnected()

    await provider.spawn({
      command: 'sh',
      cols: 80,
      rows: 24
    })

    const receivedData: string[] = []
    const receivedExits: { id: string; code: number }[] = []

    provider.onData((event) => {
      receivedData.push(event.data)
    })
    provider.onExit((event) => {
      receivedExits.push({ id: event.id, code: event.code })
    })

    // Simulate daemon broadcasting data event
    clientSocket?.write(
      `${JSON.stringify({
        type: 'event',
        event: 'data',
        id: 1,
        terminalId: 1,
        data: 'output stream line 1\n'
      })}\n`
    )

    // Simulate daemon broadcasting exit event
    clientSocket?.write(
      `${JSON.stringify({
        type: 'event',
        event: 'exit',
        id: 1,
        terminalId: 1,
        code: 0
      })}\n`
    )

    // Allow event loop to process readline
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(receivedData).toEqual(['output stream line 1\n'])
    expect(receivedExits).toEqual([{ id: '1', code: 0 }])

    provider.dispose()
  })

  it('handles write and writeWithSettlement after shutdown and with RPC error', async () => {
    const provider = new OrcadNativePtyProvider({
      endpoint: pipePath,
      spawnDaemonIfMissing: false
    })

    await provider.ensureConnected()

    await provider.spawn({
      command: 'cmd.exe',
      cols: 80,
      rows: 24
    })

    expect(provider.hasPty('1')).toBe(true)

    // Write before shutdown - writeWithSettlement on healthy active session settles accepted
    const acceptedSettlement = await provider.writeWithSettlement('1', 'echo active\r\n')
    expect(acceptedSettlement).toEqual(WRITE_ACCEPTED)

    // Shutdown the PTY
    await provider.shutdown('1')
    expect(provider.hasPty('1')).toBe(false)

    // Write after shutdown - fire and forget should not throw
    const writeResult = provider.write('1', 'echo after shutdown\r\n')
    expect(writeResult).toBe(true)

    // WriteWithSettlement for unknown/dead session where daemon returns error
    const settlement = await provider.writeWithSettlement('dead', 'echo after shutdown\r\n')
    expect(settlement).toEqual(writeRefused('transport_rejected_before_handoff'))

    provider.dispose()
  })

  it('handles pauseProducer and resumeProducer calls and aliases without throwing', async () => {
    const provider = new OrcadNativePtyProvider({
      endpoint: pipePath,
      spawnDaemonIfMissing: false
    })

    await provider.ensureConnected()

    await provider.spawn({
      command: 'cmd.exe',
      cols: 80,
      rows: 24
    })

    // Calling pauseProducer and resumeProducer on active PTY
    expect(() => provider.pauseProducer('1')).not.toThrow()
    expect(() => provider.resumeProducer('1')).not.toThrow()

    // Calling aliases pause and resume
    expect(() => provider.pause('1')).not.toThrow()
    expect(() => provider.resume('1')).not.toThrow()

    // Calling pause/resume on non-existent PTY
    expect(() => provider.pauseProducer('non-existent')).not.toThrow()
    expect(() => provider.resumeProducer('non-existent')).not.toThrow()

    // Calling setPtyBackgrounded
    expect(() => provider.setPtyBackgrounded('1', true)).not.toThrow()
    expect(() => provider.setPtyBackgrounded('1', false)).not.toThrow()

    provider.dispose()
  })

  it('correctly unregisters and disposes onData and onExit event listeners', async () => {
    const provider = new OrcadNativePtyProvider({
      endpoint: pipePath,
      spawnDaemonIfMissing: false
    })

    await provider.ensureConnected()

    await provider.spawn({
      command: 'cmd.exe',
      cols: 80,
      rows: 24
    })

    let dataCount1 = 0
    let dataCount2 = 0
    let exitCount1 = 0
    let exitCount2 = 0

    const unsubData1 = provider.onData(() => {
      dataCount1++
    })
    const unsubData2 = provider.onData(() => {
      dataCount2++
    })
    const unsubExit1 = provider.onExit(() => {
      exitCount1++
    })
    const unsubExit2 = provider.onExit(() => {
      exitCount2++
    })

    // Emit first data event
    clientSocket?.write(
      `${JSON.stringify({ type: 'event', event: 'data', terminalId: 1, data: 'first\n' })}\n`
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(dataCount1).toBe(1)
    expect(dataCount2).toBe(1)

    // Unsubscribe listener 1
    unsubData1()
    unsubExit1()

    // Emit second data event and exit event
    clientSocket?.write(
      `${JSON.stringify({ type: 'event', event: 'data', terminalId: 1, data: 'second\n' })}\n`
    )
    clientSocket?.write(
      `${JSON.stringify({ type: 'event', event: 'exit', terminalId: 1, code: 0 })}\n`
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Listener 1 should not have received updates; listener 2 should have
    expect(dataCount1).toBe(1)
    expect(dataCount2).toBe(2)
    expect(exitCount1).toBe(0)
    expect(exitCount2).toBe(1)

    // Unsubscribe listener 2
    unsubData2()
    unsubExit2()

    // Emit another event
    clientSocket?.write(
      `${JSON.stringify({ type: 'event', event: 'data', terminalId: 1, data: 'third\n' })}\n`
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(dataCount2).toBe(2)
    expect(exitCount2).toBe(1)

    provider.dispose()
  })

  it('handles write and writeWithSettlement after provider is disposed', async () => {
    const provider = new OrcadNativePtyProvider({
      endpoint: pipePath,
      spawnDaemonIfMissing: false
    })

    await provider.ensureConnected()
    expect(provider.isConnected()).toBe(true)

    // Dispose the provider
    provider.dispose()
    expect(provider.isConnected()).toBe(false)

    // Fire-and-forget write after disposal should not throw
    expect(() => provider.write('1', 'echo disposed\r\n')).not.toThrow()

    // writeWithSettlement when endpoint server is closed should return refused
    const deadPipePath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\orcad-dead-${process.pid}-${Date.now()}`
        : `/tmp/orcad-dead-${process.pid}-${Date.now()}.sock`

    const deadProvider = new OrcadNativePtyProvider({
      endpoint: deadPipePath,
      spawnDaemonIfMissing: false
    })

    const settlement = await deadProvider.writeWithSettlement('1', 'echo')
    expect(settlement).toEqual(writeRefused('transport_rejected_before_handoff'))

    deadProvider.dispose()
  })

  it('throws SessionNotFoundError on attachOnly when session is absent without calling pty.spawn', async () => {
    const provider = new OrcadNativePtyProvider({
      endpoint: pipePath,
      spawnDaemonIfMissing: false
    })

    await expect(
      provider.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'nonexistent-session',
        attachOnly: true
      })
    ).rejects.toBeInstanceOf(SessionNotFoundError)

    provider.dispose()
  })

  it('reattaches to existing active session on attachOnly without calling pty.spawn', async () => {
    const provider = new OrcadNativePtyProvider({
      endpoint: pipePath,
      spawnDaemonIfMissing: false
    })

    const initial = await provider.spawn({
      cols: 80,
      rows: 24,
      sessionId: 'sess-123'
    })

    expect(initial.id).toBe('sess-123')
    expect(initial.isReattach).toBeUndefined()

    const reattached = await provider.spawn({
      cols: 80,
      rows: 24,
      sessionId: 'sess-123',
      attachOnly: true
    })

    expect(reattached.id).toBe('sess-123')
    expect(reattached.isReattach).toBe(true)
    expect(reattached.incarnationId).toBe(initial.incarnationId)
    expect(reattached.pid).toBe(initial.pid)

    provider.dispose()
  })

  it('preserves requested sessionId in spawn result and active ptys', async () => {
    const provider = new OrcadNativePtyProvider({
      endpoint: pipePath,
      spawnDaemonIfMissing: false
    })

    const result = await provider.spawn({
      cols: 80,
      rows: 24,
      sessionId: 'custom-session-id'
    })

    expect(result.id).toBe('custom-session-id')
    expect(provider.hasPty('custom-session-id')).toBe(true)
    expect(await provider.getCwd('custom-session-id')).toBeDefined()

    provider.dispose()
  })
})
