import { describe, expect, it } from 'vitest'
import {
  classifyAntigravityTool,
  normalizeTargetFile,
  parseAntigravityTranscriptLine,
  type AntigravityTranscriptContext
} from './antigravity-usage-record-parser'

describe('antigravity-usage-record-parser', () => {
  it('classifies tools into canonical categories', () => {
    expect(classifyAntigravityTool('run_command')).toBe('terminal')
    expect(classifyAntigravityTool('replace_file_content')).toBe('edit')
    expect(classifyAntigravityTool('write_to_file')).toBe('edit')
    expect(classifyAntigravityTool('view_file')).toBe('read')
    expect(classifyAntigravityTool('search_web')).toBe('search')
    expect(classifyAntigravityTool('read_url_content')).toBe('search')
    expect(classifyAntigravityTool('invoke_subagent')).toBe('subagent')
    expect(classifyAntigravityTool('send_message')).toBe('subagent')
    expect(classifyAntigravityTool('custom_tool')).toBe('other')
  })

  it('normalizes target files relative to cwd', () => {
    expect(normalizeTargetFile('C:/project/src/index.ts', 'C:/project')).toBe('src/index.ts')
    expect(normalizeTargetFile('"C:\\project\\src\\App.tsx"', 'C:/project')).toBe('src/App.tsx')
    expect(normalizeTargetFile('relative/path.ts', null)).toBe('relative/path.ts')
  })

  it('parses a model planner response step with tokens and tool calls', () => {
    const line = JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-10-04T22:35:23Z',
      input_tokens: 23246,
      cache_read_tokens: 4000,
      output_tokens: 292,
      tool_calls: [
        {
          name: 'view_file',
          args: {
            AbsolutePath: 'C:/project/src/index.ts'
          }
        },
        {
          name: 'replace_file_content',
          args: {
            TargetFile: 'C:/project/src/App.tsx'
          }
        },
        {
          name: 'run_command',
          args: {
            CommandLine: 'pnpm test'
          }
        }
      ]
    })
    const context: AntigravityTranscriptContext = {
      sessionId: 'session-1',
      cwd: 'C:/project',
      model: 'Gemini 2.5 Flash'
    }

    const parsed = parseAntigravityTranscriptLine(line, context)
    expect(parsed).toEqual({
      sessionId: 'session-1',
      timestamp: '2026-10-04T22:35:23Z',
      model: 'Gemini 2.5 Flash',
      cwd: 'C:/project',
      inputTokens: 23246,
      cachedInputTokens: 4000,
      outputTokens: 292,
      reasoningOutputTokens: 0,
      totalTokens: 23538,
      estimatedCostUsd: expect.any(Number),
      toolCalls: [
        {
          category: 'read',
          toolName: 'view_file',
          targetFile: 'src/index.ts',
          isEdit: false,
          isRead: true
        },
        {
          category: 'edit',
          toolName: 'replace_file_content',
          targetFile: 'src/App.tsx',
          isEdit: true,
          isRead: false
        },
        {
          category: 'terminal',
          toolName: 'run_command',
          targetFile: null,
          isEdit: false,
          isRead: false
        }
      ]
    })
  })

  it('extracts cwd from tool_calls if not present in context', () => {
    const line = JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-10-04T22:35:23Z',
      input_tokens: 100,
      output_tokens: 50,
      tool_calls: [
        {
          name: 'run_command',
          args: {
            CommandLine: 'dir',
            Cwd: 'C:/my-worktree'
          }
        }
      ]
    })
    const context: AntigravityTranscriptContext = {
      sessionId: 'session-2',
      cwd: null,
      model: 'Gemini 2.5 Flash'
    }

    const parsed = parseAntigravityTranscriptLine(line, context)
    expect(context.cwd).toBe('C:/my-worktree')
    expect(parsed?.cwd).toBe('C:/my-worktree')
  })

  it('parses user input turn as an event with 0 tokens and empty toolCalls', () => {
    const line = JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-10-04T22:35:20Z',
      content: 'Hello'
    })
    const context: AntigravityTranscriptContext = {
      sessionId: 'session-3',
      cwd: 'C:/project',
      model: null
    }

    const parsed = parseAntigravityTranscriptLine(line, context)
    expect(parsed).toEqual({
      sessionId: 'session-3',
      timestamp: '2026-10-04T22:35:20Z',
      model: null,
      cwd: 'C:/project',
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: null,
      toolCalls: []
    })
  })

  it('skips non-turn lines', () => {
    const line = JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-10-04T22:35:26Z',
      content: 'output'
    })
    const context: AntigravityTranscriptContext = {
      sessionId: 'session-4',
      cwd: null,
      model: null
    }

    expect(parseAntigravityTranscriptLine(line, context)).toBeNull()
  })
})
