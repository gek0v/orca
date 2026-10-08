import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AcpRpcError } from './acp-errors'
import { AcpFilesystemHandler } from './acp-filesystem-handler'
import type { AcpRequestContext } from './acp-json-rpc-peer'

describe('AcpFilesystemHandler', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'acp-fs-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  describe('fs/read_text_file', () => {
    it('reads a complete file relative to defaultCwd', async () => {
      const filePath = path.join(tempDir, 'sample.txt')
      await writeFile(filePath, 'Hello Orca', 'utf8')

      const handler = new AcpFilesystemHandler(tempDir)
      const result = await handler.handleRequest('fs/read_text_file', {
        sessionId: 'session-1',
        path: 'sample.txt'
      })

      expect(result).toEqual({ content: 'Hello Orca' })
    })

    it('reads a file using an absolute path', async () => {
      const filePath = path.join(tempDir, 'absolute.txt')
      await writeFile(filePath, 'Absolute content', 'utf8')

      const handler = new AcpFilesystemHandler('C:\\some\\other\\path')
      const result = await handler.handleRequest('fs/read_text_file', {
        sessionId: 'session-1',
        path: filePath
      })

      expect(result).toEqual({ content: 'Absolute content' })
    })

    it('resolves relative path via dynamic getSessionCwd resolver', async () => {
      const sessionDir = path.join(tempDir, 'sess-custom')
      await mkdir(sessionDir, { recursive: true })
      await writeFile(path.join(sessionDir, 'file.txt'), 'Session scoped', 'utf8')

      const handler = new AcpFilesystemHandler((sessionId) =>
        path.join(tempDir, sessionId ?? 'default')
      )
      const result = await handler.handleRequest('fs/read_text_file', {
        sessionId: 'sess-custom',
        path: 'file.txt'
      })

      expect(result).toEqual({ content: 'Session scoped' })
    })

    it('slices lines with 1-based line index and limit', async () => {
      const content = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'].join('\n')
      await writeFile(path.join(tempDir, 'multiline.txt'), content, 'utf8')

      const handler = new AcpFilesystemHandler(tempDir)
      const result = await handler.handleRequest('fs/read_text_file', {
        sessionId: 'session-1',
        path: 'multiline.txt',
        line: 2,
        limit: 2
      })

      expect(result).toEqual({ content: 'line 2\nline 3' })
    })

    it('slices lines with 0-based start line', async () => {
      const content = ['line 1', 'line 2', 'line 3'].join('\n')
      await writeFile(path.join(tempDir, 'zero-based.txt'), content, 'utf8')

      const handler = new AcpFilesystemHandler(tempDir)
      const result = await handler.handleRequest('fs/read_text_file', {
        sessionId: 'session-1',
        path: 'zero-based.txt',
        line: 0,
        limit: 2
      })

      expect(result).toEqual({ content: 'line 1\nline 2' })
    })

    it('slices lines from start line to EOF when limit is omitted or null', async () => {
      const content = ['line 1', 'line 2', 'line 3', 'line 4'].join('\n')
      await writeFile(path.join(tempDir, 'no-limit.txt'), content, 'utf8')

      const handler = new AcpFilesystemHandler(tempDir)
      const result = await handler.handleRequest('fs/read_text_file', {
        sessionId: 'session-1',
        path: 'no-limit.txt',
        line: 3,
        limit: null
      })

      expect(result).toEqual({ content: 'line 3\nline 4' })
    })

    it('slices lines from beginning when line is omitted and limit is specified', async () => {
      const content = ['line 1', 'line 2', 'line 3'].join('\n')
      await writeFile(path.join(tempDir, 'limit-only.txt'), content, 'utf8')

      const handler = new AcpFilesystemHandler(tempDir)
      const result = await handler.handleRequest('fs/read_text_file', {
        sessionId: 'session-1',
        path: 'limit-only.txt',
        limit: 2
      })

      expect(result).toEqual({ content: 'line 1\nline 2' })
    })

    it('returns empty string when limit is 0', async () => {
      await writeFile(path.join(tempDir, 'empty-limit.txt'), 'alpha\nbeta', 'utf8')

      const handler = new AcpFilesystemHandler(tempDir)
      const result = await handler.handleRequest('fs/read_text_file', {
        sessionId: 'session-1',
        path: 'empty-limit.txt',
        line: 1,
        limit: 0
      })

      expect(result).toEqual({ content: '' })
    })

    it('returns empty string when line is beyond EOF', async () => {
      await writeFile(path.join(tempDir, 'short.txt'), 'one\ntwo', 'utf8')

      const handler = new AcpFilesystemHandler(tempDir)
      const result = await handler.handleRequest('fs/read_text_file', {
        sessionId: 'session-1',
        path: 'short.txt',
        line: 10,
        limit: 5
      })

      expect(result).toEqual({ content: '' })
    })

    it('returns all remaining lines when limit exceeds line count', async () => {
      await writeFile(path.join(tempDir, 'three-lines.txt'), 'one\ntwo\nthree', 'utf8')

      const handler = new AcpFilesystemHandler(tempDir)
      const result = await handler.handleRequest('fs/read_text_file', {
        sessionId: 'session-1',
        path: 'three-lines.txt',
        line: 2,
        limit: 100
      })

      expect(result).toEqual({ content: 'two\nthree' })
    })

    it('handles CRLF line endings cleanly when sliced', async () => {
      await writeFile(path.join(tempDir, 'crlf.txt'), 'first\r\nsecond\r\nthird', 'utf8')

      const handler = new AcpFilesystemHandler(tempDir)
      const result = await handler.handleRequest('fs/read_text_file', {
        sessionId: 'session-1',
        path: 'crlf.txt',
        line: 1,
        limit: 2
      })

      expect(result).toEqual({ content: 'first\nsecond' })
    })

    it('reads an empty file', async () => {
      await writeFile(path.join(tempDir, 'empty.txt'), '', 'utf8')

      const handler = new AcpFilesystemHandler(tempDir)
      const result = await handler.handleRequest('fs/read_text_file', {
        sessionId: 'session-1',
        path: 'empty.txt'
      })

      expect(result).toEqual({ content: '' })
    })

    it('throws AcpRpcError(-32602) on nonexistent file', async () => {
      const handler = new AcpFilesystemHandler(tempDir)

      await expect(
        handler.handleRequest('fs/read_text_file', {
          sessionId: 'session-1',
          path: 'missing.txt'
        })
      ).rejects.toSatisfy((error) => {
        return error instanceof AcpRpcError && error.code === -32602
      })
    })

    it('throws AcpRpcError(-32602) when reading a directory', async () => {
      const handler = new AcpFilesystemHandler(tempDir)

      await expect(
        handler.handleRequest('fs/read_text_file', {
          sessionId: 'session-1',
          path: ''
        })
      ).rejects.toSatisfy((error) => {
        return error instanceof AcpRpcError && error.code === -32602
      })
    })

    it('throws AcpRpcError(-32602) on invalid params', async () => {
      const handler = new AcpFilesystemHandler(tempDir)

      await expect(
        handler.handleRequest('fs/read_text_file', {
          path: 'sample.txt'
        })
      ).rejects.toSatisfy((error) => {
        return error instanceof AcpRpcError && error.code === -32602
      })

      await expect(
        handler.handleRequest('fs/read_text_file', {
          sessionId: 'session-1',
          path: 'sample.txt',
          line: -1
        })
      ).rejects.toSatisfy((error) => {
        return error instanceof AcpRpcError && error.code === -32602
      })
    })
  })

  describe('fs/write_text_file', () => {
    it('writes text file relative to cwd', async () => {
      const handler = new AcpFilesystemHandler(tempDir)
      const result = await handler.handleRequest('fs/write_text_file', {
        sessionId: 'session-1',
        path: 'output.txt',
        content: 'Written content'
      })

      expect(result).toEqual({})
      const saved = await readFile(path.join(tempDir, 'output.txt'), 'utf8')
      expect(saved).toBe('Written content')
    })

    it('writes text file using absolute path', async () => {
      const absPath = path.join(tempDir, 'nested', 'direct.txt')
      const handler = new AcpFilesystemHandler('C:\\dummy')
      const result = await handler.handleRequest('fs/write_text_file', {
        sessionId: 'session-1',
        path: absPath,
        content: 'Direct absolute write'
      })

      expect(result).toEqual({})
      const saved = await readFile(absPath, 'utf8')
      expect(saved).toBe('Direct absolute write')
    })

    it('recursively creates parent directories when writing', async () => {
      const handler = new AcpFilesystemHandler(tempDir)
      const result = await handler.handleRequest('fs/write_text_file', {
        sessionId: 'session-1',
        path: 'deep/sub/dir/nested.txt',
        content: 'Deep content'
      })

      expect(result).toEqual({})
      const saved = await readFile(path.join(tempDir, 'deep', 'sub', 'dir', 'nested.txt'), 'utf8')
      expect(saved).toBe('Deep content')
    })

    it('overwrites an existing file', async () => {
      const filePath = path.join(tempDir, 'overwrite.txt')
      await writeFile(filePath, 'Initial', 'utf8')

      const handler = new AcpFilesystemHandler(tempDir)
      await handler.handleRequest('fs/write_text_file', {
        sessionId: 'session-1',
        path: 'overwrite.txt',
        content: 'Updated'
      })

      const saved = await readFile(filePath, 'utf8')
      expect(saved).toBe('Updated')
    })

    it('writes empty content', async () => {
      const handler = new AcpFilesystemHandler(tempDir)
      await handler.handleRequest('fs/write_text_file', {
        sessionId: 'session-1',
        path: 'empty.txt',
        content: ''
      })

      const saved = await readFile(path.join(tempDir, 'empty.txt'), 'utf8')
      expect(saved).toBe('')
    })

    it('throws AcpRpcError(-32602) on invalid write params', async () => {
      const handler = new AcpFilesystemHandler(tempDir)

      await expect(
        handler.handleRequest('fs/write_text_file', {
          sessionId: 'session-1',
          path: 'output.txt'
        })
      ).rejects.toSatisfy((error) => {
        return error instanceof AcpRpcError && error.code === -32602
      })
    })

    it('throws AcpRpcError(-32602) when writing to an existing directory path', async () => {
      const subDir = path.join(tempDir, 'existing-dir')
      await mkdir(subDir)

      const handler = new AcpFilesystemHandler(tempDir)
      await expect(
        handler.handleRequest('fs/write_text_file', {
          sessionId: 'session-1',
          path: 'existing-dir',
          content: 'conflict'
        })
      ).rejects.toSatisfy((error) => {
        return error instanceof AcpRpcError && error.code === -32602
      })
    })
  })

  describe('unsupported methods and context', () => {
    it('throws AcpRpcError(-32601) on unknown method', async () => {
      const handler = new AcpFilesystemHandler(tempDir)

      await expect(
        handler.handleRequest('fs/delete_file', {
          sessionId: 'session-1',
          path: 'file.txt'
        })
      ).rejects.toSatisfy((error) => {
        return error instanceof AcpRpcError && error.code === -32601
      })
    })

    it('accepts AcpRequestContext parameter without error', async () => {
      await writeFile(path.join(tempDir, 'context.txt'), 'Context test', 'utf8')

      const handler = new AcpFilesystemHandler(tempDir)
      const context: AcpRequestContext = {
        id: 'req-1',
        signal: new AbortController().signal
      }

      const result = await handler.handleRequest(
        'fs/read_text_file',
        {
          sessionId: 'session-1',
          path: 'context.txt'
        },
        context
      )

      expect(result).toEqual({ content: 'Context test' })
    })
  })
})
