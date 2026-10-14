// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTauriPreloadApi,
  installTauriPreloadApi,
  setInitialCachedSettings
} from './tauri-preload-adapter'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockImplementation((cmd, args) => Promise.resolve({ cmd, args }))
}))

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
