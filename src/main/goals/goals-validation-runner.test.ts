import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { GoalsValidationRunner } from './goals-validation-runner'

describe('GoalsValidationRunner', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-val-test-'))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('executes a shell command and captures exit code and log file', async () => {
    const runner = new GoalsValidationRunner()
    const cmd = 'echo pass'
    const result = await runner.runValidation(tempDir, cmd)

    expect(result.exitCode).toBe(0)
    expect(result.status).toBe('success')
    expect(result.command).toBe(cmd)
    expect(typeof result.lastRunAt).toBe('number')

    const logPath = path.join(tempDir, '.orca', 'last_validation.log')
    const logContent = await fs.readFile(logPath, 'utf8')
    expect(logContent).toContain('pass')
  })

  it('executes compound shell commands (&& and pipes)', async () => {
    const runner = new GoalsValidationRunner()
    const cmd =
      process.platform === 'win32' ? 'echo first&& echo second' : 'echo first && echo second'
    const result = await runner.runValidation(tempDir, cmd)

    expect(result.exitCode).toBe(0)
    expect(result.status).toBe('success')

    const logPath = path.join(tempDir, '.orca', 'last_validation.log')
    const logContent = await fs.readFile(logPath, 'utf8')
    expect(logContent).toContain('first')
    expect(logContent).toContain('second')
  })

  it('handles failing commands and captures failure status and exit code', async () => {
    const runner = new GoalsValidationRunner()
    const cmd = process.platform === 'win32' ? 'cmd /c exit 1' : 'exit 1'
    const result = await runner.runValidation(tempDir, cmd)

    expect(result.exitCode).toBe(1)
    expect(result.status).toBe('failed')
  })

  it('extracts summaryTail limited to last 10 non-empty lines and capped at 500 characters', async () => {
    const runner = new GoalsValidationRunner()
    // Generate a command that outputs 15 lines of text
    const cmd =
      process.platform === 'win32'
        ? 'for /L %i in (1,1,15) do @echo line %i'
        : 'for i in $(seq 1 15); do echo "line $i"; done'
    const result = await runner.runValidation(tempDir, cmd)

    expect(result.exitCode).toBe(0)
    expect(result.summaryTail).toBeDefined()
    const lines = result.summaryTail!.split('\n')
    expect(lines.length).toBeLessThanOrEqual(10)
    expect(result.summaryTail!.length).toBeLessThanOrEqual(500)
    expect(result.summaryTail).toContain('line 15')
    expect(result.summaryTail).not.toContain('line 1\n')
  })

  it('cancels previous running validation if a new one is started for the same workspace/goal', async () => {
    const runner = new GoalsValidationRunner()
    const slowCmd = process.platform === 'win32' ? 'ping -n 5 127.0.0.1 >nul' : 'sleep 5'
    const fastCmd = 'echo fast'

    const p1 = runner.runValidation(tempDir, slowCmd, 'goal-1')
    const p2 = runner.runValidation(tempDir, fastCmd, 'goal-1')

    const [r1, r2] = await Promise.allSettled([p1, p2])

    expect(r2.status).toBe('fulfilled')
    if (r2.status === 'fulfilled') {
      expect(r2.value.status).toBe('success')
    }

    // First run should have been cancelled / aborted
    if (r1.status === 'fulfilled') {
      expect(r1.value.status).toBe('failed')
    } else {
      expect(r1.reason).toBeDefined()
    }
  })

  it('fails with timeout if execution exceeds timeoutMs', async () => {
    const runner = new GoalsValidationRunner()
    const slowCmd = process.platform === 'win32' ? 'ping -n 5 127.0.0.1 >nul' : 'sleep 5'

    const result = await runner.runValidation(tempDir, slowCmd, 'goal-1', { timeoutMs: 150 })

    expect(result.status).toBe('failed')
  })

  it('handles empty output gracefully by leaving summaryTail undefined', async () => {
    const runner = new GoalsValidationRunner()
    const cmd = process.platform === 'win32' ? 'cd .' : ':'
    const result = await runner.runValidation(tempDir, cmd)

    expect(result.exitCode).toBe(0)
    expect(result.status).toBe('success')
    expect(result.summaryTail).toBeUndefined()
  })

  it('caps summaryTail at 500 characters when lines are very long', async () => {
    const runner = new GoalsValidationRunner()
    const longString = 'A'.repeat(600)
    const cmd = `echo ${longString}`
    const result = await runner.runValidation(tempDir, cmd)

    expect(result.exitCode).toBe(0)
    expect(result.summaryTail).toBeDefined()
    expect(result.summaryTail!.length).toBeLessThanOrEqual(500)
  })

  it('allows explicit cancellation via cancelValidation and dispose', async () => {
    const runner = new GoalsValidationRunner()
    const slowCmd = process.platform === 'win32' ? 'ping -n 5 127.0.0.1 >nul' : 'sleep 5'

    const promise = runner.runValidation(tempDir, slowCmd, 'goal-cancel')
    runner.cancelValidation(tempDir, 'goal-cancel')

    await expect(promise).rejects.toThrow('Validation was aborted by a newer run')

    const p2 = runner.runValidation(tempDir, slowCmd, 'goal-dispose')
    runner.dispose()
    await expect(p2).rejects.toThrow('Validation was aborted by a newer run')
  })
})
