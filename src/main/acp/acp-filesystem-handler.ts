import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AcpRpcError } from './acp-errors'
import type { AcpRequestContext } from './acp-json-rpc-peer'
import {
  ReadTextFileRequestSchema,
  ReadTextFileResponseSchema,
  type ReadTextFileResponse,
  WriteTextFileRequestSchema,
  WriteTextFileResponseSchema,
  type WriteTextFileResponse
} from './generated/acp-protocol.generated'

export type AcpCwdResolver = string | ((sessionId?: string) => string)

export class AcpFilesystemHandler {
  constructor(private readonly defaultCwd: AcpCwdResolver) {}

  async handleRequest(
    method: string,
    params: unknown,
    _context?: AcpRequestContext
  ): Promise<unknown> {
    switch (method) {
      case 'fs/read_text_file':
        return this.handleReadTextFile(params)
      case 'fs/write_text_file':
        return this.handleWriteTextFile(params)
      default:
        throw new AcpRpcError(-32601, `Unknown ACP method: ${method}`)
    }
  }

  private async handleReadTextFile(params: unknown): Promise<ReadTextFileResponse> {
    const parsed = ReadTextFileRequestSchema.safeParse(params)
    if (!parsed.success) {
      throw new AcpRpcError(-32602, parsed.error.message)
    }

    const { sessionId, path: targetPath, line, limit } = parsed.data
    const sessionCwd = this.resolveCwd(sessionId)
    const resolvedPath = path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : path.resolve(sessionCwd, targetPath)

    let content: string
    try {
      content = await readFile(resolvedPath, 'utf8')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new AcpRpcError(-32602, message)
    }

    const hasLine = line !== undefined && line !== null
    const hasLimit = limit !== undefined && limit !== null

    if (hasLine || hasLimit) {
      const lines = content.split(/\r?\n/)
      const startIndex = hasLine ? (line >= 1 ? line - 1 : 0) : 0
      const endIndex = hasLimit ? startIndex + limit : undefined
      content = lines.slice(startIndex, endIndex).join('\n')
    }

    return ReadTextFileResponseSchema.parse({ content })
  }

  private async handleWriteTextFile(params: unknown): Promise<WriteTextFileResponse> {
    const parsed = WriteTextFileRequestSchema.safeParse(params)
    if (!parsed.success) {
      throw new AcpRpcError(-32602, parsed.error.message)
    }

    const { sessionId, path: targetPath, content } = parsed.data
    const sessionCwd = this.resolveCwd(sessionId)
    const resolvedPath = path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : path.resolve(sessionCwd, targetPath)

    try {
      await mkdir(path.dirname(resolvedPath), { recursive: true })
      await writeFile(resolvedPath, content, 'utf8')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new AcpRpcError(-32602, message)
    }

    return WriteTextFileResponseSchema.parse({})
  }

  private resolveCwd(sessionId?: string): string {
    if (typeof this.defaultCwd === 'function') {
      return this.defaultCwd(sessionId)
    }
    return this.defaultCwd
  }
}
