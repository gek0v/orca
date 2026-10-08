import { EventEmitter } from 'node:events'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { ProcessSpec, spawnProcess } from '../../shared/child-process/run-process'
import { AcpRpcError } from './acp-errors'
import type { AcpRequestContext } from './acp-json-rpc-peer'
import { AcpTerminalHandler } from './acp-terminal-handler'

type MockChild = ReturnType<typeof spawnProcess> & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
}

function createMockChild(pid = 4321): MockChild {
  const child = new EventEmitter()
  let exitCode: number | null = null
  let signalCode: string | null = null
  const mock = Object.assign(child, {
    pid,
    get exitCode(): number | null {
      return exitCode
    },
    set exitCode(value: number | null) {
      exitCode = value
    },
    get signalCode(): string | null {
      return signalCode
    },
    set signalCode(value: string | null) {
      signalCode = value
    },
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn((sig?: string) => {
      signalCode = sig ?? 'SIGTERM'
      child.emit('close', null, signalCode)
      return true
    })
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test mock for ChildProcessWithoutNullStreams.
  return mock as unknown as MockChild
}

describe('AcpTerminalHandler', () => {
  describe('terminal/create', () => {
    it('creates a terminal and returns a valid terminalId', async () => {
      const mockChild = createMockChild()
      const spawnSpy = vi.fn((_spec: ProcessSpec) => mockChild)
      const handler = new AcpTerminalHandler('C:\\default\\cwd', spawnSpy)

      const result = await handler.handleRequest('terminal/create', {
        sessionId: 'session-1',
        command: 'my-bin',
        args: ['--flag', 'value']
      })

      expect(result).toMatchObject({
        terminalId: expect.stringMatching(/^term-[0-9a-f-]+$/)
      })
      expect(spawnSpy).toHaveBeenCalledTimes(1)
      const spec = spawnSpy.mock.calls[0]?.[0]
      expect(spec?.program).toBe('my-bin')
      expect(spec?.args).toEqual(['--flag', 'value'])
      expect(spec?.cwd).toBe('C:\\default\\cwd')
    })

    it('resolves relative cwd against default cwd', async () => {
      const mockChild = createMockChild()
      const spawnSpy = vi.fn((_spec: ProcessSpec) => mockChild)
      const handler = new AcpTerminalHandler('/base/dir', spawnSpy)

      await handler.handleRequest('terminal/create', {
        sessionId: 'session-1',
        command: 'echo',
        cwd: 'subdir'
      })

      const spec = spawnSpy.mock.calls[0]?.[0]
      expect(spec?.cwd).toBe(path.resolve('/base/dir', 'subdir'))
    })

    it('uses absolute cwd directly when provided', async () => {
      const mockChild = createMockChild()
      const spawnSpy = vi.fn((_spec: ProcessSpec) => mockChild)
      const handler = new AcpTerminalHandler('/base/dir', spawnSpy)
      const absoluteCwd = path.resolve('/custom/absolute/path')

      await handler.handleRequest('terminal/create', {
        sessionId: 'session-1',
        command: 'echo',
        cwd: absoluteCwd
      })

      const spec = spawnSpy.mock.calls[0]?.[0]
      expect(spec?.cwd).toBe(absoluteCwd)
    })

    it('resolves cwd dynamically via resolver function', async () => {
      const mockChild = createMockChild()
      const spawnSpy = vi.fn((_spec: ProcessSpec) => mockChild)
      const resolver = (sessionId?: string) => `/workspace/${sessionId ?? 'default'}`
      const handler = new AcpTerminalHandler(resolver, spawnSpy)

      await handler.handleRequest('terminal/create', {
        sessionId: 'session-abc',
        command: 'pwd'
      })

      const spec = spawnSpy.mock.calls[0]?.[0]
      expect(spec?.cwd).toBe('/workspace/session-abc')
    })

    it('merges custom env variables with process.env', async () => {
      const mockChild = createMockChild()
      const spawnSpy = vi.fn((_spec: ProcessSpec) => mockChild)
      const handler = new AcpTerminalHandler('/base', spawnSpy)

      await handler.handleRequest('terminal/create', {
        sessionId: 'session-1',
        command: 'sh',
        env: [
          { name: 'ORCA_TEST_VAR_A', value: 'apple' },
          { name: 'ORCA_TEST_VAR_B', value: 'banana' }
        ]
      })

      const spec = spawnSpy.mock.calls[0]?.[0]
      expect(spec?.env?.ORCA_TEST_VAR_A).toBe('apple')
      expect(spec?.env?.ORCA_TEST_VAR_B).toBe('banana')
      expect(spec?.env?.PATH).toBe(process.env.PATH)
    })

    it('throws AcpRpcError(-32602) on invalid request parameters', async () => {
      const handler = new AcpTerminalHandler(
        '/base',
        vi.fn((_spec: ProcessSpec) => createMockChild())
      )

      await expect(
        handler.handleRequest('terminal/create', {
          command: 'echo'
        })
      ).rejects.toSatisfy((err) => err instanceof AcpRpcError && err.code === -32602)

      await expect(
        handler.handleRequest('terminal/create', {
          sessionId: 'session-1'
        })
      ).rejects.toSatisfy((err) => err instanceof AcpRpcError && err.code === -32602)

      await expect(
        handler.handleRequest('terminal/create', {
          sessionId: 'session-1',
          command: 'echo',
          outputByteLimit: -10
        })
      ).rejects.toSatisfy((err) => err instanceof AcpRpcError && err.code === -32602)
    })

    it('throws AcpRpcError(-32603) when spawnImpl fails synchronously', async () => {
      const failingSpawn = vi.fn((_spec: ProcessSpec): ReturnType<typeof spawnProcess> => {
        throw new Error('Spawn failed')
      })
      const handler = new AcpTerminalHandler('/base', failingSpawn)

      await expect(
        handler.handleRequest('terminal/create', {
          sessionId: 'session-1',
          command: 'bad-bin'
        })
      ).rejects.toSatisfy((err) => err instanceof AcpRpcError && err.code === -32603)
    })
  })

  describe('terminal/output', () => {
    it('captures stdout from the child process', async () => {
      const mockChild = createMockChild()
      const handler = new AcpTerminalHandler('/base', () => mockChild)

      const createRes = await handler.handleRequest('terminal/create', {
        sessionId: 'session-1',
        command: 'echo'
      })

      mockChild.stdout.write('line 1\n')
      mockChild.stdout.write('line 2\n')

      const outputRes = await handler.handleRequest('terminal/output', {
        sessionId: 'session-1',
        terminalId: createRes.terminalId
      })

      expect(outputRes).toEqual({
        output: 'line 1\nline 2\n',
        truncated: false,
        exitStatus: null
      })
    })

    it('captures combined stdout and stderr', async () => {
      const mockChild = createMockChild()
      const handler = new AcpTerminalHandler('/base', () => mockChild)

      const createRes = await handler.handleRequest('terminal/create', {
        sessionId: 'session-1',
        command: 'echo'
      })

      mockChild.stdout.write('stdout msg\n')
      mockChild.stderr.write('stderr msg\n')

      const outputRes = await handler.handleRequest('terminal/output', {
        sessionId: 'session-1',
        terminalId: createRes.terminalId
      })

      expect(outputRes).toEqual({
        output: 'stdout msg\nstderr msg\n',
        truncated: false,
        exitStatus: null
      })
    })

    it('reports exitStatus when process terminates cleanly', async () => {
      const mockChild = createMockChild()
      const handler = new AcpTerminalHandler('/base', () => mockChild)

      const createRes = await handler.handleRequest('terminal/create', {
        sessionId: 'session-1',
        command: 'echo'
      })

      mockChild.stdout.write('done')
      mockChild.emit('close', 0, null)

      const outputRes = await handler.handleRequest('terminal/output', {
        sessionId: 'session-1',
        terminalId: createRes.terminalId
      })

      expect(outputRes).toEqual({
        output: 'done',
        truncated: false,
        exitStatus: {
          exitCode: 0,
          signal: null
        }
      })
    })

    it('reports exitStatus with signal when terminated by signal', async () => {
      const mockChild = createMockChild()
      const handler = new AcpTerminalHandler('/base', () => mockChild)

      const createRes = await handler.handleRequest('terminal/create', {
        sessionId: 'session-1',
        command: 'long-job'
      })

      mockChild.emit('close', null, 'SIGTERM')

      const outputRes = await handler.handleRequest('terminal/output', {
        sessionId: 'session-1',
        terminalId: createRes.terminalId
      })

      expect(outputRes).toEqual({
        output: '',
        truncated: false,
        exitStatus: {
          exitCode: null,
          signal: 'SIGTERM'
        }
      })
    })

    it('truncates output when outputByteLimit is reached', async () => {
      const mockChild = createMockChild()
      const handler = new AcpTerminalHandler('/base', () => mockChild)

      const createRes = await handler.handleRequest('terminal/create', {
        sessionId: 'session-1',
        command: 'echo',
        outputByteLimit: 10
      })

      mockChild.stdout.write('012345')
      mockChild.stdout.write('6789extra_bytes_that_should_be_cut')

      const outputRes = await handler.handleRequest('terminal/output', {
        sessionId: 'session-1',
        terminalId: createRes.terminalId
      })

      expect(outputRes).toEqual({
        output: '0123456789',
        truncated: true,
        exitStatus: null
      })
    })

    it('handles outputByteLimit of 0 bytes', async () => {
      const mockChild = createMockChild()
      const handler = new AcpTerminalHandler('/base', () => mockChild)

      const createRes = await handler.handleRequest('terminal/create', {
        sessionId: 'session-1',
        command: 'echo',
        outputByteLimit: 0
      })

      mockChild.stdout.write('any output')

      const outputRes = await handler.handleRequest('terminal/output', {
        sessionId: 'session-1',
        terminalId: createRes.terminalId
      })

      expect(outputRes).toEqual({
        output: '',
        truncated: true,
        exitStatus: null
      })
    })

    it('throws AcpRpcError(-32602) for nonexistent terminal', async () => {
      const handler = new AcpTerminalHandler('/base', () => createMockChild())

      await expect(
        handler.handleRequest('terminal/output', {
          sessionId: 'session-1',
          terminalId: 'term-nonexistent'
        })
      ).rejects.toSatisfy(
        (err) =>
          err instanceof AcpRpcError &&
          err.code === -32602 &&
          err.message.includes('Terminal not found')
      )
    })

    it('throws AcpRpcError(-32602) when sessionId does not match', async () => {
      const mockChild = createMockChild()
      const handler = new AcpTerminalHandler('/base', () => mockChild)

      const createRes = await handler.handleRequest('terminal/create', {
        sessionId: 'session-owner',
        command: 'echo'
      })

      await expect(
        handler.handleRequest('terminal/output', {
          sessionId: 'session-other',
          terminalId: createRes.terminalId
        })
      ).rejects.toSatisfy(
        (err) =>
          err instanceof AcpRpcError &&
          err.code === -32602 &&
          err.message.includes('Terminal not found')
      )
    })
  })

  describe('terminal/wait_for_exit', () => {
    it('resolves when the process exits', async () => {
      const mockChild = createMockChild()
      const handler = new AcpTerminalHandler('/base', () => mockChild)

      const createRes = await handler.handleRequest('terminal/create', {
        sessionId: 'session-1',
        command: 'echo'
      })

      const waitPromise = handler.handleRequest('terminal/wait_for_exit', {
        sessionId: 'session-1',
        terminalId: createRes.terminalId
      })

      mockChild.emit('close', 0, null)

      const result = await waitPromise
      expect(result).toEqual({
        exitCode: 0,
        signal: null
      })
    })

    it('resolves immediately if the process has already exited', async () => {
      const mockChild = createMockChild()
      const handler = new AcpTerminalHandler('/base', () => mockChild)

      const createRes = await handler.handleRequest('terminal/create', {
        sessionId: 'session-1',
        command: 'echo'
      })

      mockChild.emit('close', 42, null)

      const result = await handler.handleRequest('terminal/wait_for_exit', {
        sessionId: 'session-1',
        terminalId: createRes.terminalId
      })

      expect(result).toEqual({
        exitCode: 42,
        signal: null
      })
    })

    it('resolves multiple concurrent wait_for_exit callers', async () => {
      const mockChild = createMockChild()
      const handler = new AcpTerminalHandler('/base', () => mockChild)

      const createRes = await handler.handleRequest('terminal/create', {
        sessionId: 'session-1',
        command: 'echo'
      })

      const wait1 = handler.handleRequest('terminal/wait_for_exit', {
        sessionId: 'session-1',
        terminalId: createRes.terminalId
      })
      const wait2 = handler.handleRequest('terminal/wait_for_exit', {
        sessionId: 'session-1',
        terminalId: createRes.terminalId
      })

      mockChild.emit('close', 1, null)

      const [res1, res2] = await Promise.all([wait1, wait2])
      expect(res1).toEqual({ exitCode: 1, signal: null })
      expect(res2).toEqual({ exitCode: 1, signal: null })
    })

    it('rejects immediately when context signal is already aborted', async () => {
      const mockChild = createMockChild()
      const handler = new AcpTerminalHandler('/base', () => mockChild)

      const createRes = await handler.handleRequest('terminal/create', {
        sessionId: 'session-1',
        command: 'echo'
      })

      const controller = new AbortController()
      controller.abort(new Error('Pre-aborted'))

      const context: AcpRequestContext = {
        id: 'req-1',
        signal: controller.signal
      }

      await expect(
        handler.handleRequest(
          'terminal/wait_for_exit',
          {
            sessionId: 'session-1',
            terminalId: createRes.terminalId
          },
          context
        )
      ).rejects.toThrow('Pre-aborted')
    })

    it('rejects when context signal aborts while waiting, leaving other waiters active', async () => {
      const mockChild = createMockChild()
      const handler = new AcpTerminalHandler('/base', () => mockChild)

      const createRes = await handler.handleRequest('terminal/create', {
        sessionId: 'session-1',
        command: 'echo'
      })

      const controller = new AbortController()
      const contextAborted: AcpRequestContext = {
        id: 'req-abort',
        signal: controller.signal
      }

      const abortedWait = handler.handleRequest(
        'terminal/wait_for_exit',
        {
          sessionId: 'session-1',
          terminalId: createRes.terminalId
        },
        contextAborted
      )

      const regularWait = handler.handleRequest('terminal/wait_for_exit', {
        sessionId: 'session-1',
        terminalId: createRes.terminalId
      })

      controller.abort(new Error('Cancelled while waiting'))

      await expect(abortedWait).rejects.toThrow('Cancelled while waiting')

      mockChild.emit('close', 0, null)
      const regularResult = await regularWait
      expect(regularResult).toEqual({ exitCode: 0, signal: null })
    })

    it('resolves when child emits exit without explicit close event', async () => {
      const mockChild = createMockChild()
      const handler = new AcpTerminalHandler('/base', () => mockChild)

      const createRes = await handler.handleRequest('terminal/create', {
        sessionId: 'session-1',
        command: 'echo'
      })

      const waitPromise = handler.handleRequest('terminal/wait_for_exit', {
        sessionId: 'session-1',
        terminalId: createRes.terminalId
      })

      mockChild.emit('exit', 0, null)

      const result = await waitPromise
      expect(result).toEqual({ exitCode: 0, signal: null })
    })
  })

  describe('terminal/kill', () => {
    it('kills the process and returns empty response', async () => {
      const mockChild = createMockChild()
      const handler = new AcpTerminalHandler('/base', () => mockChild)

      const createRes = await handler.handleRequest('terminal/create', {
        sessionId: 'session-1',
        command: 'echo'
      })

      const killRes = await handler.handleRequest('terminal/kill', {
        sessionId: 'session-1',
        terminalId: createRes.terminalId
      })

      expect(killRes).toEqual({})
    })

    it('throws AcpRpcError(-32602) when killing nonexistent terminal', async () => {
      const handler = new AcpTerminalHandler('/base', () => createMockChild())

      await expect(
        handler.handleRequest('terminal/kill', {
          sessionId: 'session-1',
          terminalId: 'term-missing'
        })
      ).rejects.toSatisfy((err) => err instanceof AcpRpcError && err.code === -32602)
    })
  })

  describe('terminal/release', () => {
    it('releases the terminal and removes it from state', async () => {
      const mockChild = createMockChild()
      const handler = new AcpTerminalHandler('/base', () => mockChild)

      const createRes = await handler.handleRequest('terminal/create', {
        sessionId: 'session-1',
        command: 'echo'
      })

      const releaseRes = await handler.handleRequest('terminal/release', {
        sessionId: 'session-1',
        terminalId: createRes.terminalId
      })

      expect(releaseRes).toEqual({})

      await expect(
        handler.handleRequest('terminal/output', {
          sessionId: 'session-1',
          terminalId: createRes.terminalId
        })
      ).rejects.toSatisfy((err) => err instanceof AcpRpcError && err.code === -32602)
    })

    it('succeeds releasing an already exited terminal', async () => {
      const mockChild = createMockChild()
      const handler = new AcpTerminalHandler('/base', () => mockChild)

      const createRes = await handler.handleRequest('terminal/create', {
        sessionId: 'session-1',
        command: 'echo'
      })

      mockChild.emit('close', 0, null)

      const releaseRes = await handler.handleRequest('terminal/release', {
        sessionId: 'session-1',
        terminalId: createRes.terminalId
      })

      expect(releaseRes).toEqual({})
    })
  })

  describe('releaseSessionTerminals', () => {
    it('cleans up all terminals for a specific session', async () => {
      const mock1 = createMockChild()
      const mock2 = createMockChild()
      const mockOther = createMockChild()

      let callIndex = 0
      const spawnSpy = vi.fn((_spec: ProcessSpec) => {
        callIndex += 1
        if (callIndex === 1) {
          return mock1
        }
        if (callIndex === 2) {
          return mock2
        }
        return mockOther
      })

      const handler = new AcpTerminalHandler('/base', spawnSpy)

      const t1 = await handler.handleRequest('terminal/create', {
        sessionId: 'session-target',
        command: 'echo'
      })

      const t2 = await handler.handleRequest('terminal/create', {
        sessionId: 'session-target',
        command: 'echo'
      })

      const tOther = await handler.handleRequest('terminal/create', {
        sessionId: 'session-keep',
        command: 'echo'
      })

      await handler.releaseSessionTerminals('session-target')

      await expect(
        handler.handleRequest('terminal/output', {
          sessionId: 'session-target',
          terminalId: t1.terminalId
        })
      ).rejects.toSatisfy((err) => err instanceof AcpRpcError && err.code === -32602)

      await expect(
        handler.handleRequest('terminal/output', {
          sessionId: 'session-target',
          terminalId: t2.terminalId
        })
      ).rejects.toSatisfy((err) => err instanceof AcpRpcError && err.code === -32602)

      const keepOutput = await handler.handleRequest('terminal/output', {
        sessionId: 'session-keep',
        terminalId: tOther.terminalId
      })
      expect(keepOutput).toBeDefined()
    })
  })

  describe('protocol routing', () => {
    it('throws AcpRpcError(-32601) on unknown method', async () => {
      const handler = new AcpTerminalHandler(
        '/base',
        vi.fn((_spec: ProcessSpec) => createMockChild())
      )

      await expect(
        handler.handleRequest('terminal/unknown_method', {
          sessionId: 'session-1'
        })
      ).rejects.toSatisfy((err) => err instanceof AcpRpcError && err.code === -32601)
    })
  })

  describe('cross-platform real process integration', () => {
    it('executes a real node command, waits for exit, and captures stdout', async () => {
      const handler = new AcpTerminalHandler(process.cwd())

      const createRes = await handler.handleRequest('terminal/create', {
        sessionId: 'session-real',
        command: process.execPath,
        args: ['-e', 'process.stdout.write("orca-terminal-integration-test\\n")']
      })

      const waitRes = await handler.handleRequest('terminal/wait_for_exit', {
        sessionId: 'session-real',
        terminalId: createRes.terminalId
      })

      expect(waitRes).toEqual({
        exitCode: 0,
        signal: null
      })

      const outputRes = await handler.handleRequest('terminal/output', {
        sessionId: 'session-real',
        terminalId: createRes.terminalId
      })

      expect(outputRes).toEqual({
        output: 'orca-terminal-integration-test\n',
        truncated: false,
        exitStatus: {
          exitCode: 0,
          signal: null
        }
      })
    })

    it('captures stderr and non-zero exit code from real process', async () => {
      const handler = new AcpTerminalHandler(process.cwd())

      const createRes = await handler.handleRequest('terminal/create', {
        sessionId: 'session-real',
        command: process.execPath,
        args: ['-e', 'process.stderr.write("real error\\n"); process.exit(7)']
      })

      const waitRes = await handler.handleRequest('terminal/wait_for_exit', {
        sessionId: 'session-real',
        terminalId: createRes.terminalId
      })

      expect(waitRes).toEqual({
        exitCode: 7,
        signal: null
      })

      const outputRes = await handler.handleRequest('terminal/output', {
        sessionId: 'session-real',
        terminalId: createRes.terminalId
      })

      expect(outputRes).toEqual({
        output: 'real error\n',
        truncated: false,
        exitStatus: {
          exitCode: 7,
          signal: null
        }
      })
    })

    it('kills a running real process and cleans it up via release', async () => {
      const handler = new AcpTerminalHandler(process.cwd())

      const createRes = await handler.handleRequest('terminal/create', {
        sessionId: 'session-real',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)']
      })

      const killRes = await handler.handleRequest('terminal/kill', {
        sessionId: 'session-real',
        terminalId: createRes.terminalId
      })
      expect(killRes).toEqual({})

      const waitRes = await handler.handleRequest('terminal/wait_for_exit', {
        sessionId: 'session-real',
        terminalId: createRes.terminalId
      })

      expect(waitRes).toBeDefined()

      const releaseRes = await handler.handleRequest('terminal/release', {
        sessionId: 'session-real',
        terminalId: createRes.terminalId
      })
      expect(releaseRes).toEqual({})
    })
  })
})
