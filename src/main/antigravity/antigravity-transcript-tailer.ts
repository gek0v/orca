import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs'

export type AntigravityToolCall = {
  name: string
  args: Record<string, unknown>
}

export type AntigravityTranscriptStep = {
  step_index: number
  source?: 'USER_EXPLICIT' | 'MODEL' | 'SYSTEM' | (string & {})
  type: 'USER_INPUT' | 'PLANNER_RESPONSE' | (string & {})
  status?: 'DONE' | 'ERROR' | 'RUNNING' | (string & {})
  created_at?: string
  content?: string
  thinking?: string
  tool_calls?: AntigravityToolCall[]
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const CHUNK_SIZE = 64 * 1024

export class AntigravityTranscriptTailer {
  private byteOffset = 0
  private partialLine = ''
  private isClosed = false

  constructor(public readonly transcriptPath: string) {}

  public getOffset(): number {
    return this.byteOffset
  }

  public setOffset(offset: number): void {
    this.byteOffset = Math.max(0, offset)
    this.partialLine = ''
  }

  public close(): void {
    this.isClosed = true
    this.partialLine = ''
  }

  /**
   * Reads and parses any newly appended JSON lines in the transcript file
   * starting from the current byte offset.
   */
  public pollNewSteps(): AntigravityTranscriptStep[] {
    if (this.isClosed || !existsSync(this.transcriptPath)) {
      return []
    }

    let fileSize = 0
    try {
      fileSize = statSync(this.transcriptPath).size
    } catch {
      return []
    }

    if (fileSize <= this.byteOffset) {
      if (fileSize < this.byteOffset) {
        // File was truncated or rotated, reset
        this.byteOffset = 0
        this.partialLine = ''
      }
      return []
    }

    let fd: number | null = null
    try {
      fd = openSync(this.transcriptPath, 'r')
    } catch {
      return []
    }

    const steps: AntigravityTranscriptStep[] = []
    const buffer = Buffer.alloc(CHUNK_SIZE)

    try {
      while (this.byteOffset < fileSize) {
        const bytesToRead = Math.min(CHUNK_SIZE, fileSize - this.byteOffset)
        const bytesRead = readSync(fd, buffer, 0, bytesToRead, this.byteOffset)
        if (bytesRead <= 0) {
          break
        }

        this.byteOffset += bytesRead
        const chunkStr = buffer.toString('utf8', 0, bytesRead)
        const combined = this.partialLine + chunkStr
        const lines = combined.split(/\r?\n/)

        // The last element is either empty (if ended with newline) or a partial line
        this.partialLine = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) {
            continue
          }
          try {
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Parsed JSON is checked before being cast to AntigravityTranscriptStep
            const parsed = JSON.parse(trimmed) as Record<string, unknown>
            if (
              typeof parsed === 'object' &&
              parsed !== null &&
              ('type' in parsed || 'step_index' in parsed)
            ) {
              steps.push(this.normalizeStep(parsed))
            }
          } catch {
            // Skip corrupted or unparseable lines
          }
        }
      }
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          // ignore
        }
      }
    }

    return steps
  }

  private normalizeStep(raw: Record<string, unknown>): AntigravityTranscriptStep {
    const stepIndex = typeof raw.step_index === 'number' ? raw.step_index : 0
    const source = typeof raw.source === 'string' ? raw.source : undefined
    const type = typeof raw.type === 'string' ? raw.type : 'UNKNOWN'
    const status = typeof raw.status === 'string' ? raw.status : undefined
    const createdAt = typeof raw.created_at === 'string' ? raw.created_at : undefined
    const content = typeof raw.content === 'string' ? raw.content : undefined
    const thinking = typeof raw.thinking === 'string' ? raw.thinking : undefined

    let toolCalls: AntigravityToolCall[] | undefined
    if (Array.isArray(raw.tool_calls)) {
      toolCalls = []
      for (const call of raw.tool_calls) {
        if (
          typeof call === 'object' &&
          call !== null &&
          'name' in call &&
          typeof call.name === 'string'
        ) {
          const args = isRecord(call.args) ? call.args : {}
          toolCalls.push({ name: call.name, args })
        }
      }
    }

    const inputTokens = typeof raw.input_tokens === 'number' ? raw.input_tokens : undefined
    const outputTokens = typeof raw.output_tokens === 'number' ? raw.output_tokens : undefined
    const cacheReadTokens =
      typeof raw.cache_read_tokens === 'number' ? raw.cache_read_tokens : undefined

    return {
      step_index: stepIndex,
      source,
      type,
      status,
      created_at: createdAt,
      content,
      thinking,
      tool_calls: toolCalls,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheReadTokens
    }
  }
}
