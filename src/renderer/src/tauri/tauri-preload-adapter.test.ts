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
        activeRepoId: 'repo-1'
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Testing session persistence mock return.
      vi.mocked(invoke).mockResolvedValueOnce(
        dummySession as unknown as Awaited<ReturnType<typeof api.session.get>>
      )
      const sessionData = await api.session.get()
      expect(sessionData).toEqual(dummySession)
      expect(invoke).toHaveBeenCalledWith('sessions_load', undefined)

      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Testing session persistence mock argument.
      await api.session.set(dummySession as unknown as Parameters<typeof api.session.set>[0])
      expect(invoke).toHaveBeenCalledWith('sessions_save', {
        sessions: dummySession
      })
    })

    it('dispatches orcad and watcher commands', async () => {
      const api = createTauriPreloadApi()
      const { invoke } = await import('@tauri-apps/api/core')

      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Testing orcad direct IPC adapter invoke.
      const orcadApi = (
        api as unknown as { orcad: { invoke: (m: string, p?: unknown) => Promise<unknown> } }
      ).orcad
      await orcadApi.invoke('workspace.ping', { echo: 'hello' })
      expect(invoke).toHaveBeenCalledWith('orcad_invoke', {
        method: 'workspace.ping',
        params: { echo: 'hello' }
      })

      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Testing watcher adapter methods.
      const watcherApi = (
        api as unknown as {
          watcher: {
            watch: (id: string, p: string) => Promise<unknown>
            unwatch: (id: string) => Promise<unknown>
          }
        }
      ).watcher
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
