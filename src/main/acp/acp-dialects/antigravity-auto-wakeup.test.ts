import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { AntigravityAutoWakeupWatcher } from './antigravity-auto-wakeup'
import type { AcpStructuredChild } from '../session/children/acp-structured-child'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('AntigravityAutoWakeupWatcher', () => {
  let tempDir: string
  let transcriptPath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agy-wakeup-test-'))
    transcriptPath = join(tempDir, 'transcript.jsonl')
    await writeFile(transcriptPath, '{"step": 1}\n', 'utf8')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  function createMockSession(running = false): {
    session: AcpStructuredChild
    dispatched: unknown[]
  } {
    const dispatched: unknown[] = []
    const session = {
      sessionId: 'test-session',
      ended: false,
      closeRequested: false,
      turns: {
        running,
        dispatch: vi.fn((send) => {
          dispatched.push(send)
        })
      }
    } as unknown as AcpStructuredChild
    return { session, dispatched }
  }

  it('dispatches a wakeup prompt when transcript grows while idle', async () => {
    const { session, dispatched } = createMockSession(false)
    const watcher = new AntigravityAutoWakeupWatcher(session, transcriptPath)
    await watcher.start()

    // No changes yet
    const initialCheck = await watcher.checkAndWakeup()
    expect(initialCheck).toBe(false)
    expect(dispatched).toHaveLength(0)

    // Append new line to transcript
    await writeFile(transcriptPath, '{"step": 1}\n{"step": 2, "content": "Done"}\n', 'utf8')

    const woken = await watcher.checkAndWakeup()
    expect(woken).toBe(true)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]).toMatchObject({
      clientMessageId: expect.stringContaining('antigravity-wakeup:'),
      prompt: [{ type: 'text', text: ' ' }]
    })

    watcher.dispose()
  })

  it('does not dispatch when turns is already running', async () => {
    const { session, dispatched } = createMockSession(true)
    const watcher = new AntigravityAutoWakeupWatcher(session, transcriptPath)
    await watcher.start()

    await writeFile(transcriptPath, '{"step": 1}\n{"step": 2}\n', 'utf8')

    const woken = await watcher.checkAndWakeup()
    expect(woken).toBe(false)
    expect(dispatched).toHaveLength(0)

    watcher.dispose()
  })

  it('does not dispatch after disposal', async () => {
    const { session, dispatched } = createMockSession(false)
    const watcher = new AntigravityAutoWakeupWatcher(session, transcriptPath)
    await watcher.start()
    watcher.dispose()

    await writeFile(transcriptPath, '{"step": 1}\n{"step": 2}\n', 'utf8')

    const woken = await watcher.checkAndWakeup()
    expect(woken).toBe(false)
    expect(dispatched).toHaveLength(0)
  })
})
