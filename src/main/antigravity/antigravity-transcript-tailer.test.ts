import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { AntigravityTranscriptTailer } from './antigravity-transcript-tailer'

describe('AntigravityTranscriptTailer', () => {
  let tempDir: string
  let transcriptPath: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-transcript-tailer-test-'))
    transcriptPath = join(tempDir, 'transcript.jsonl')
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('returns empty when file does not exist yet', () => {
    const tailer = new AntigravityTranscriptTailer(transcriptPath)
    expect(tailer.pollNewSteps()).toEqual([])
    tailer.close()
  })

  it('polls initial lines and advances offset correctly', () => {
    const step1 = JSON.stringify({
      step_index: 0,
      type: 'USER_INPUT',
      content: 'Hello Antigravity'
    })
    const step2 = JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      thinking: 'Analyzing request...',
      content: 'I will help you.'
    })
    writeFileSync(transcriptPath, `${step1}\n${step2}\n`, 'utf8')

    const tailer = new AntigravityTranscriptTailer(transcriptPath)
    const initialSteps = tailer.pollNewSteps()

    expect(initialSteps).toHaveLength(2)
    expect(initialSteps[0].type).toBe('USER_INPUT')
    expect(initialSteps[0].content).toBe('Hello Antigravity')
    expect(initialSteps[1].type).toBe('PLANNER_RESPONSE')
    expect(initialSteps[1].thinking).toBe('Analyzing request...')
    expect(tailer.getOffset()).toBeGreaterThan(0)

    // Second poll without changes returns empty
    expect(tailer.pollNewSteps()).toEqual([])

    // Append new line
    const step3 = JSON.stringify({
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls' } }]
    })
    appendFileSync(transcriptPath, `${step3}\n`, 'utf8')

    const nextSteps = tailer.pollNewSteps()
    expect(nextSteps).toHaveLength(1)
    expect(nextSteps[0].step_index).toBe(2)
    expect(nextSteps[0].tool_calls?.[0].name).toBe('run_command')

    tailer.close()
  })

  it('handles partial line buffering correctly', () => {
    const step1 = JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'Partial test' })
    writeFileSync(transcriptPath, step1.slice(0, 20), 'utf8')

    const tailer = new AntigravityTranscriptTailer(transcriptPath)
    expect(tailer.pollNewSteps()).toHaveLength(0)

    // Complete the line
    appendFileSync(transcriptPath, `${step1.slice(20)}\n`, 'utf8')
    const steps = tailer.pollNewSteps()
    expect(steps).toHaveLength(1)
    expect(steps[0].content).toBe('Partial test')

    tailer.close()
  })
})
