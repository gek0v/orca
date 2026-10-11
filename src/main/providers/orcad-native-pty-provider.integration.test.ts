import * as path from 'node:path'
import * as fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { OrcadNativePtyProvider } from './orcad-native-pty-provider'

describe('OrcadNativePtyProvider Live Integration', () => {
  it('connects to real compiled orcad.exe binary and executes a command', async () => {
    const binaryPath = path.resolve(
      process.cwd(),
      process.platform === 'win32' ? 'dist/bin/orcad.exe' : 'dist/bin/orcad'
    )

    if (!fs.existsSync(binaryPath)) {
      return
    }

    const testPipe =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\orcad-live-test-${process.pid}-${Date.now()}`
        : `/tmp/orcad-live-test-${process.pid}-${Date.now()}.sock`

    const provider = new OrcadNativePtyProvider({
      endpoint: testPipe,
      binaryPath,
      spawnDaemonIfMissing: true
    })

    try {
      await provider.ensureConnected()
      expect(provider.isConnected()).toBe(true)

      const outputChunks: string[] = []

      provider.onData((event) => {
        outputChunks.push(event.data)
      })

      const exitPromise = new Promise<number>((resolve) => {
        provider.onExit((event) => {
          resolve(event.code)
        })
      })

      const cmd = process.platform === 'win32' ? 'cmd.exe' : 'sh'
      const args =
        process.platform === 'win32'
          ? ['/c', 'echo NATIVE_ORCAD_LIVE_SUCCESS']
          : ['-c', 'echo NATIVE_ORCAD_LIVE_SUCCESS']

      const spawnRes = await provider.spawn({
        command: cmd,
        terminalShellArgs: args,
        cols: 80,
        rows: 24,
        cwd: process.cwd()
      })

      expect(spawnRes.id).toBeDefined()
      expect(spawnRes.pid).toBeTypeOf('number')

      const code = await Promise.race([
        exitPromise,
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error('PTY exit timed out')), 5000)
        )
      ])

      expect(code).toBe(0)
      const fullOutput = outputChunks.join('')
      expect(fullOutput).toContain('NATIVE_ORCAD_LIVE_SUCCESS')
    } finally {
      provider.dispose()
    }
  })
})
