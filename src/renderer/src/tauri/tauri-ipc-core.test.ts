// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isTauriEnvironment, invokeTauri, subscribeTauri } from './tauri-ipc-core'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockImplementation((cmd, args) => Promise.resolve({ cmd, args }))
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockImplementation((_event, _cb) => Promise.resolve(vi.fn()))
}))

describe('tauri-ipc-core', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    Reflect.deleteProperty(window, '__TAURI__')
  })

  afterEach(() => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    Reflect.deleteProperty(window, '__TAURI__')
  })

  describe('isTauriEnvironment', () => {
    it('returns false when window has no tauri markers', () => {
      expect(isTauriEnvironment()).toBe(false)
    })

    it('returns true when __TAURI_INTERNALS__ is present', () => {
      Reflect.set(window, '__TAURI_INTERNALS__', {})
      expect(isTauriEnvironment()).toBe(true)
    })

    it('returns true when __TAURI__ is present', () => {
      Reflect.set(window, '__TAURI__', {})
      expect(isTauriEnvironment()).toBe(true)
    })
  })

  describe('invokeTauri', () => {
    it('forwards command and arguments to tauri invoke', async () => {
      const result = await invokeTauri<{ cmd: string; args?: unknown }>('ping', { test: 123 })
      expect(result).toEqual({ cmd: 'ping', args: { test: 123 } })
    })
  })

  describe('subscribeTauri', () => {
    it('registers event listener and returns unlisten disposer', async () => {
      const mockUnlisten = vi.fn()
      const { listen } = await import('@tauri-apps/api/event')
      vi.mocked(listen).mockResolvedValueOnce(mockUnlisten)

      const callback = vi.fn()
      const unsubscribe = subscribeTauri('test-event', callback)
      expect(typeof unsubscribe).toBe('function')

      // Await promise resolution inside subscribeTauri
      await Promise.resolve()
      unsubscribe()
      expect(mockUnlisten).toHaveBeenCalledTimes(1)
    })
  })
})
