// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTauriPreloadApi,
  installTauriPreloadApi,
  setInitialCachedSettings
} from './tauri-preload-adapter'

vi.mock('@tauri-apps/api/core', () => {
  class MockChannel<T> {
    onmessage?: (data: T) => void
    send(data: T): void {
      this.onmessage?.(data)
    }
  }
  return {
    invoke: vi.fn().mockImplementation((cmd, args) => Promise.resolve({ cmd, args })),
    Channel: MockChannel
  }
})

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockImplementation((_event, _cb) => Promise.resolve(vi.fn()))
}))

describe('tauri-preload-adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    Reflect.deleteProperty(window, '__TAURI__')
  })

  afterEach(() => {
    sessionStorage.clear()
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    Reflect.deleteProperty(window, '__TAURI__')
  })

  describe('createTauriPreloadApi', () => {
    it('provides synchronous settings cache via getSync', () => {
      const api = createTauriPreloadApi()
      expect(api.settings.getSync()).toBeNull()

      setInitialCachedSettings({ theme: 'dark' })
      expect(api.settings.getSync()).toEqual({ theme: 'dark' })
    })

    it('updates synchronous settings cache on settings.set', async () => {
      const api = createTauriPreloadApi()
      setInitialCachedSettings({ theme: 'dark' })

      await api.settings.set({ theme: 'light' })
      expect(api.settings.getSync()).toEqual({ theme: 'light' })
    })

    it('synchronously snapshots to sessionStorage in stageBeforeUnloadSync', () => {
      const api = createTauriPreloadApi()
      const payload = { sessions: [], ui: {} }

      api.app.stageBeforeUnloadSync(payload)
      const stored = sessionStorage.getItem('orca:stage-before-unload-snapshot')
      expect(stored).toBe(JSON.stringify(payload))
    })

    it('dispatches window control commands via ui namespace', async () => {
      const api = createTauriPreloadApi()
      const { invoke } = await import('@tauri-apps/api/core')

      api.ui.minimize()
      expect(invoke).toHaveBeenCalledWith('window_minimize', undefined)

      api.ui.maximize()
      expect(invoke).toHaveBeenCalledWith('window_toggle_maximize', undefined)

      api.ui.requestClose()
      expect(invoke).toHaveBeenCalledWith('window_close', undefined)

      api.ui.confirmWindowClose()
      expect(invoke).toHaveBeenCalledWith('app_confirm_close_ready', undefined)
    })

    it('dispatches dynamic domains and methods via proxy', async () => {
      const api = createTauriPreloadApi()
      const { invoke } = await import('@tauri-apps/api/core')

      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Testing dynamic proxy dispatch on un-overridden domain.
      const customDomain = api.projects as unknown as { listAll: (arg: string) => Promise<unknown> }
      await customDomain.listAll('workspace-1')
      expect(invoke).toHaveBeenCalledWith('projects_listAll', { args: ['workspace-1'] })
    })

    it('dispatches pty commands and decodes 16-byte frames', async () => {
      const api = createTauriPreloadApi()
      const { invoke } = await import('@tauri-apps/api/core')

      const receivedData: { id: string; data: string }[] = []
      const unsubscribeData = api.pty.onData((data) => {
        receivedData.push(data)
      })

      const receivedExit: { id: string; code: number }[] = []
      const unsubscribeExit = api.pty.onExit((exit) => {
        receivedExit.push(exit)
      })

      const spawnResult = await api.pty.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'pty-test-1'
      })
      expect(spawnResult.id).toBe('pty-test-1')
      expect(invoke).toHaveBeenCalledWith(
        'pty_spawn',
        expect.objectContaining({
          descriptor: expect.objectContaining({
            session_id: 'pty-test-1',
            cols: 80,
            rows: 24
          })
        })
      )

      // Simulate binary frame receipt over Channel:
      const payloadText = 'Hello PTY!'
      const textBytes = new TextEncoder().encode(payloadText)
      const frame = new Uint8Array(16 + textBytes.length)
      frame[0] = 0x74
      frame[1] = 1
      frame[2] = 1 // Output
      frame.set(textBytes, 16)

      const lastCall = vi.mocked(invoke).mock.calls.find((call) => call[0] === 'pty_spawn')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test inspection of mocked channel argument.
      const channelArg = (lastCall?.[1] as { on_event?: { send: (data: Uint8Array) => void } })
        ?.on_event
      channelArg?.send(frame)

      expect(receivedData).toEqual([{ id: 'pty-test-1', data: 'Hello PTY!' }])

      // Write test
      api.pty.write('pty-test-1', 'ls\n', 'driving')
      expect(invoke).toHaveBeenCalledWith('pty_write', {
        sessionId: 'pty-test-1',
        data: Array.from(new TextEncoder().encode('ls\n'))
      })

      // Resize test
      api.pty.resize('pty-test-1', 120, 40)
      expect(invoke).toHaveBeenCalledWith('pty_resize', {
        sessionId: 'pty-test-1',
        cols: 120,
        rows: 40
      })

      // Kill test
      await api.pty.kill('pty-test-1')
      expect(invoke).toHaveBeenCalledWith('pty_kill', {
        sessionId: 'pty-test-1'
      })

      unsubscribeData()
      unsubscribeExit()
    })

    it('dispatches credentials commands for opencodeGoCredentials', async () => {
      const api = createTauriPreloadApi()
      const { invoke } = await import('@tauri-apps/api/core')

      vi.mocked(invoke).mockResolvedValueOnce('sk-secret')
      const status1 = await api.opencodeGoCredentials.getStatus()
      expect(status1).toEqual({ apiKeyConfigured: true })
      expect(invoke).toHaveBeenCalledWith('credentials_get', {
        account: 'opencode-go'
      })

      vi.mocked(invoke).mockResolvedValueOnce(undefined)
      const saveRes = await api.opencodeGoCredentials.saveApiKey('sk-new-secret')
      expect(saveRes).toEqual({ apiKeyConfigured: true })
      expect(invoke).toHaveBeenCalledWith('credentials_set', {
        account: 'opencode-go',
        secret: 'sk-new-secret'
      })

      vi.mocked(invoke).mockResolvedValueOnce(true)
      const clearRes = await api.opencodeGoCredentials.clearApiKey()
      expect(clearRes).toEqual({ apiKeyConfigured: false })
      expect(invoke).toHaveBeenCalledWith('credentials_delete', {
        account: 'opencode-go'
      })
    })

    it('dispatches session and settings commands to native persistence', async () => {
      const api = createTauriPreloadApi()
      const { invoke } = await import('@tauri-apps/api/core')

      const dummySession = {
        activeRepoId: 'repo-1',
        activeWorktreeId: null,
        activeTabId: null,
        tabsByWorktree: {},
        terminalLayoutsByTabId: {}
      }
      vi.mocked(invoke).mockResolvedValueOnce(dummySession)
      const sessionData = await api.session.get()
      expect(sessionData).toEqual(dummySession)
      expect(invoke).toHaveBeenCalledWith('sessions_load', undefined)

      await api.session.set(dummySession)
      expect(invoke).toHaveBeenCalledWith('sessions_save', {
        sessions: dummySession
      })
    })

    it('dispatches orcad and watcher commands', async () => {
      const api = createTauriPreloadApi()
      const { invoke } = await import('@tauri-apps/api/core')

      const orcadApi = Reflect.get(api, 'orcad')
      await orcadApi.invoke('workspace.ping', { echo: 'hello' })
      expect(invoke).toHaveBeenCalledWith('orcad_invoke', {
        method: 'workspace.ping',
        params: { echo: 'hello' }
      })

      const watcherApi = Reflect.get(api, 'watcher')
      await watcherApi.watch('watch-1', '/path/to/project')
      expect(invoke).toHaveBeenCalledWith('watcher_watch', {
        watchId: 'watch-1',
        path: '/path/to/project'
      })

      await watcherApi.unwatch('watch-1')
      expect(invoke).toHaveBeenCalledWith('watcher_unwatch', {
        watchId: 'watch-1'
      })
    })

    it('decodes 32-bit exit codes and single-byte legacy codes', async () => {
      const api = createTauriPreloadApi()
      const { invoke } = await import('@tauri-apps/api/core')

      const receivedExit: { id: string; code: number }[] = []
      const unsubscribeExit = api.pty.onExit((exit) => {
        receivedExit.push(exit)
      })

      await api.pty.spawn({ cols: 80, rows: 24, sessionId: 'pty-exit-32' })
      const lastCall = vi.mocked(invoke).mock.calls.find((call) => call[0] === 'pty_spawn')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test inspection of mocked channel argument.
      const channelArg = (lastCall?.[1] as { on_event?: { send: (data: Uint8Array) => void } })
        ?.on_event

      // 1. 32-bit exit code 256 (0x00000100)
      const exitFrame256 = new Uint8Array(20)
      exitFrame256[0] = 0x74
      exitFrame256[1] = 1
      exitFrame256[2] = 2
      const dv256 = new DataView(exitFrame256.buffer)
      dv256.setUint32(16, 256, true)
      channelArg?.send(exitFrame256)

      // 2. 32-bit NTSTATUS code (0xC0000005 = 3221225477)
      const exitFrameCrash = new Uint8Array(20)
      exitFrameCrash[0] = 0x74
      exitFrameCrash[1] = 1
      exitFrameCrash[2] = 2
      const dvCrash = new DataView(exitFrameCrash.buffer)
      dvCrash.setUint32(16, 3221225477, true)
      channelArg?.send(exitFrameCrash)

      // 3. Fallback single-byte exit code (17 bytes)
      const exitFrameFallback = new Uint8Array(17)
      exitFrameFallback[0] = 0x74
      exitFrameFallback[1] = 1
      exitFrameFallback[2] = 2
      exitFrameFallback[16] = 42
      channelArg?.send(exitFrameFallback)

      expect(receivedExit).toEqual([
        { id: 'pty-exit-32', code: 256 },
        { id: 'pty-exit-32', code: 3221225477 },
        { id: 'pty-exit-32', code: 42 }
      ])

      unsubscribeExit()
    })

    it('decodes multi-byte UTF-8 streams split across chunk boundaries', async () => {
      const api = createTauriPreloadApi()
      const { invoke } = await import('@tauri-apps/api/core')

      const receivedData: { id: string; data: string }[] = []
      const unsubscribeData = api.pty.onData((data) => {
        receivedData.push(data)
      })

      await api.pty.spawn({ cols: 80, rows: 24, sessionId: 'pty-utf8-stream' })
      const lastCall = vi.mocked(invoke).mock.calls.find((call) => call[0] === 'pty_spawn')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test inspection of mocked channel argument.
      const channelArg = (lastCall?.[1] as { on_event?: { send: (data: Uint8Array) => void } })
        ?.on_event

      // Euro symbol '€' UTF-8 bytes: [0xE2, 0x82, 0xAC]
      const prefixBytes = new TextEncoder().encode('Price: ')
      const chunk1Payload = new Uint8Array(prefixBytes.length + 1)
      chunk1Payload.set(prefixBytes, 0)
      chunk1Payload[prefixBytes.length] = 0xe2

      const frame1 = new Uint8Array(16 + chunk1Payload.length)
      frame1[0] = 0x74
      frame1[1] = 1
      frame1[2] = 1
      frame1.set(chunk1Payload, 16)
      channelArg?.send(frame1)

      const suffixBytes = new TextEncoder().encode('50')
      const chunk2Payload = new Uint8Array(2 + suffixBytes.length)
      chunk2Payload[0] = 0x82
      chunk2Payload[1] = 0xac
      chunk2Payload.set(suffixBytes, 2)

      const frame2 = new Uint8Array(16 + chunk2Payload.length)
      frame2[0] = 0x74
      frame2[1] = 1
      frame2[2] = 1
      frame2.set(chunk2Payload, 16)
      channelArg?.send(frame2)

      expect(receivedData).toEqual([
        { id: 'pty-utf8-stream', data: 'Price: ' },
        { id: 'pty-utf8-stream', data: '€50' }
      ])

      unsubscribeData()
    })

    it('returns synchronous platform information via platform.get', () => {
      const api = createTauriPreloadApi()
      const info = api.platform.get()

      expect(['win32', 'darwin', 'linux']).toContain(info.platform)
      expect(['powershell.exe', '/bin/bash']).toContain(info.shell)
      expect(info.osRelease).toBe('10.0.0')
      expect(info.arch).toBe('x64')
      expect(info.displayServer).toBe('wayland')
    })

    it('executes pty stubs without dispatching unhandled commands', async () => {
      const api = createTauriPreloadApi()
      const { invoke } = await import('@tauri-apps/api/core')
      const initialInvokeCount = vi.mocked(invoke).mock.calls.length

      api.pty.ackData('pty-1', 128, 256)
      api.pty.clearBuffer('pty-1')
      api.pty.resetInputModes('pty-1')
      api.pty.claimViewport('pty-1', 120, 30)
      api.pty.reportGeometry('pty-1', 120, 30)
      api.pty.rendererDispatcherReady()

      expect(vi.mocked(invoke).mock.calls.length).toBe(initialInvokeCount)

      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Testing pty.create alias.
      const ptyWithCreate = api.pty as unknown as {
        create: (opts: unknown) => Promise<{ id: string }>
      }
      const created = await ptyWithCreate.create({ cols: 80, rows: 24, sessionId: 'pty-alias-1' })
      expect(created.id).toBe('pty-alias-1')
      expect(invoke).toHaveBeenCalledWith('pty_spawn', expect.anything())
    })

    it('provides pty.management stubs without errors', async () => {
      const api = createTauriPreloadApi()
      const mgmt = api.pty.management

      expect(mgmt).toBeDefined()
      expect(await mgmt.listSessions()).toEqual({ sessions: [], degraded: false })
      expect(await mgmt.killAll()).toEqual({
        killedCount: 0,
        remainingCount: 0,
        killedSessionIds: []
      })
      expect(await mgmt.killOne({ sessionId: 'dummy' })).toEqual({ success: false })
      expect(await mgmt.restart()).toEqual({ success: false })
      expect(await mgmt.macTccAttribution()).toEqual({
        health: 'unknown',
        folderAccessMismatch: null
      })
      expect(await mgmt.resetFolderAccess()).toEqual({ outcome: 'unsupported' })
    })

    it('refreshes synchronous settings cache when settings.get is called', async () => {
      const api = createTauriPreloadApi()
      const { invoke } = await import('@tauri-apps/api/core')

      vi.mocked(invoke).mockResolvedValueOnce({ theme: 'midnight-blue' })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Testing settings.get with key parameter.
      const settingsWithKey = api.settings as unknown as {
        get: (k?: string) => Promise<unknown>
        getSync: (k?: string) => unknown
      }
      const theme = await settingsWithKey.get('theme')
      expect(theme).toBe('midnight-blue')
      expect(settingsWithKey.getSync('theme')).toBe('midnight-blue')

      vi.mocked(invoke).mockResolvedValueOnce({ theme: 'solarized-light', fontSize: 16 })
      const fullSettings = await api.settings.get()
      expect(fullSettings).toEqual({ theme: 'solarized-light', fontSize: 16 })
      expect(api.settings.getSync()).toEqual({ theme: 'solarized-light', fontSize: 16 })
    })

    it('handles on* subscriptions through explicit and dynamic proxies with unlisten fallbacks', () => {
      const api = createTauriPreloadApi()

      const unsubscribeSettings = api.settings.onChanged(() => {})
      expect(typeof unsubscribeSettings).toBe('function')
      expect(() => unsubscribeSettings()).not.toThrow()

      const unsubscribeKeybindings = api.keybindings.onChanged(() => {})
      expect(typeof unsubscribeKeybindings).toBe('function')
      expect(() => unsubscribeKeybindings()).not.toThrow()
    })

    it('handles listener errors and sessionStorage exceptions gracefully', async () => {
      const api = createTauriPreloadApi()
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      api.pty.onData(() => {
        throw new Error('Listener crash')
      })
      await api.pty.spawn({ cols: 80, rows: 24, sessionId: 'pty-err-test' })
      const { invoke } = await import('@tauri-apps/api/core')
      const lastCall = vi.mocked(invoke).mock.calls.find((call) => call[0] === 'pty_spawn')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test inspection of mocked channel argument.
      const channelArg = (lastCall?.[1] as { on_event?: { send: (data: Uint8Array) => void } })
        ?.on_event

      const dataFrame = new Uint8Array(17)
      dataFrame[0] = 0x74
      dataFrame[1] = 1
      dataFrame[2] = 1
      dataFrame[16] = 65
      expect(() => channelArg?.send(dataFrame)).not.toThrow()
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[TauriAdapter] Error in pty:onData listener:'),
        expect.any(Error)
      )

      const setItemSpy = vi.spyOn(sessionStorage, 'setItem').mockImplementationOnce(() => {
        throw new Error('QuotaExceededError')
      })
      expect(() => api.app.stageBeforeUnloadSync({ sessions: [], ui: {} })).not.toThrow()
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          '[TauriAdapter] Failed to mirror stageBeforeUnload to sessionStorage:'
        ),
        expect.any(Error)
      )

      vi.mocked(invoke).mockResolvedValueOnce(null)
      const sessionResult = await api.session.get()
      expect(sessionResult).toEqual({ schemaVersion: 1 })

      consoleErrorSpy.mockRestore()
      setItemSpy.mockRestore()
    })
  })

  describe('installTauriPreloadApi', () => {
    it('attaches to window.api when running inside Tauri environment', () => {
      Reflect.set(window, '__TAURI_INTERNALS__', {})
      installTauriPreloadApi()
      expect(window.api).toBeDefined()
      expect(typeof window.api.ui.requestClose).toBe('function')
    })

    it('does not overwrite window.api when not running in Tauri environment', () => {
      const dummyApi = { dummy: true }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Testing fallback retention when not in Tauri.
      window.api = dummyApi as unknown as typeof window.api

      installTauriPreloadApi()
      expect(window.api).toBe(dummyApi)
    })
  })
})
