import * as net from 'node:net'
import * as readline from 'node:readline'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
            } else if (req.method === 'terminal.create') {
              socket.write(
                `${JSON.stringify({
                  jsonrpc: '2.0',
                  id: req.id,
                  result: { ok: true, id: 1, pid: 4242 }
                })}\n`
              )
            } else if (req.method === 'terminal.write' || req.method === 'terminal.input') {
              socket.write(
                `${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true } })}\n`
              )
            } else if (req.method === 'terminal.resize') {
              socket.write(
                `${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true } })}\n`
              )
            } else if (req.method === 'terminal.kill' || req.method === 'terminal.shutdown') {
              socket.write(
                `${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true } })}\n`
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

  it('connects to orcad endpoint and performs ping/spawn/write/resize/shutdown lifecycle', async () => {
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
})
