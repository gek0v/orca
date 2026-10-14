import type { PreloadApi } from '../../../preload/api-types'
import { Channel, invokeTauri, isTauriEnvironment, subscribeTauri } from './tauri-ipc-core'

let cachedSettings: Record<string, unknown> | null = null

const ptyDataListeners = new Set<(data: { id: string; data: string }) => void>()
const ptyExitListeners = new Set<(data: { id: string; code: number }) => void>()

function dispatchPtyData(id: string, data: string): void {
  for (const listener of ptyDataListeners) {
    try {
      listener({ id, data })
    } catch (err) {
      console.error('[TauriAdapter] Error in pty:onData listener:', err)
    }
  }
}

function dispatchPtyExit(id: string, code: number): void {
  for (const listener of ptyExitListeners) {
    try {
      listener({ id, code })
    } catch (err) {
      console.error('[TauriAdapter] Error in pty:onExit listener:', err)
    }
  }
}

export function setInitialCachedSettings(settings: Record<string, unknown>): void {
  cachedSettings = settings
}

export function getInitialCachedSettings(): Record<string, unknown> | null {
  return cachedSettings
}

export function createTauriPreloadApi(): PreloadApi {
  const explicitOverrides: Record<string, Record<string, unknown>> = {
    app: {
      getVersion: () => invokeTauri<string>('app_get_version'),
      getName: () => invokeTauri<string>('app_get_name'),
      relaunch: () => invokeTauri<void>('plugin:process|restart'),
      stageBeforeUnloadSync: (args: unknown) => {
        try {
          sessionStorage.setItem('orca:stage-before-unload-snapshot', JSON.stringify(args))
        } catch (error) {
          console.error(
            '[TauriAdapter] Failed to mirror stageBeforeUnload to sessionStorage:',
            error
          )
        }
        void invokeTauri('app_stage_before_unload', { args })
      },
      showOpenDialog: (options: unknown) => invokeTauri('plugin:dialog|open', { options }),
      showSaveDialog: (options: unknown) => invokeTauri('plugin:dialog|save', { options })
    },
    settings: {
      get: () => invokeTauri('settings_get'),
      getSync: () => cachedSettings,
      set: (args: Record<string, unknown>) => {
        cachedSettings = { ...cachedSettings, ...args }
        return invokeTauri('settings_update', { patch: args })
      }
    },
    ui: {
      minimize: () => {
        void invokeTauri('window_minimize')
      },
      maximize: () => {
        void invokeTauri('window_toggle_maximize')
      },
      isMaximized: () => invokeTauri<boolean>('window_is_maximized'),
      requestClose: () => {
        void invokeTauri('window_close')
      },
      confirmWindowClose: () => {
        void invokeTauri('app_confirm_close_ready')
      },
      onWindowCloseRequested: (callback: (data: { isQuitting: boolean }) => void) => {
        return subscribeTauri<{ isQuitting?: boolean }>('app:prepare-close', (payload) => {
          callback({ isQuitting: payload?.isQuitting ?? false })
        })
      }
    },
    platform: {
      getPlatform: () => invokeTauri<string>('get_platform')
    },
    fs: {
      readFile: (path: string, options?: unknown) =>
        invokeTauri<string>('plugin:fs|read_file', { path, options }),
      writeFile: (path: string, content: unknown) =>
        invokeTauri<void>('plugin:fs|write_file', { path, content }),
      stat: (path: string) => invokeTauri('plugin:fs|stat', { path }),
      exists: (path: string) => invokeTauri<boolean>('plugin:fs|exists', { path })
    },
    pty: {
      spawn: async (opts: {
        cols: number
        rows: number
        cwd?: string
        command?: string
        sessionId?: string
      }) => {
        const sessionId =
          opts.sessionId ?? `pty-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        const command =
          opts.command ??
          (typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
            ? 'powershell.exe'
            : '/bin/bash')
        const channel = new Channel<number[] | Uint8Array>()

        channel.onmessage = (frameRaw: number[] | Uint8Array) => {
          const frameBytes = frameRaw instanceof Uint8Array ? frameRaw : new Uint8Array(frameRaw)
          if (frameBytes.length >= 16 && frameBytes[0] === 0x74) {
            const opcode = frameBytes[2]
            if (opcode === 1) {
              const text = new TextDecoder().decode(frameBytes.subarray(16))
              dispatchPtyData(sessionId, text)
            } else if (opcode === 2) {
              const exitCode = frameBytes[16] ?? 0
              dispatchPtyExit(sessionId, exitCode)
            }
          }
        }

        await invokeTauri('pty_spawn', {
          descriptor: {
            session_id: sessionId,
            command,
            args: [],
            cwd: opts.cwd ?? null,
            cols: opts.cols,
            rows: opts.rows
          },
          on_event: channel
        })

        return { id: sessionId }
      },
      write: (id: string, data: string) => {
        const bytes = Array.from(new TextEncoder().encode(data))
        void invokeTauri('pty_write', { sessionId: id, data: bytes })
      },
      writeAccepted: async (id: string, data: string) => {
        const bytes = Array.from(new TextEncoder().encode(data))
        await invokeTauri('pty_write', { sessionId: id, data: bytes })
        return true
      },
      resize: (id: string, cols: number, rows: number) => {
        void invokeTauri('pty_resize', { sessionId: id, cols, rows })
      },
      kill: async (id: string) => {
        await invokeTauri('pty_kill', { sessionId: id })
      },
      onData: (callback: (data: { id: string; data: string }) => void) => {
        ptyDataListeners.add(callback)
        return () => {
          ptyDataListeners.delete(callback)
        }
      },
      onExit: (callback: (data: { id: string; code: number }) => void) => {
        ptyExitListeners.add(callback)
        return () => {
          ptyExitListeners.delete(callback)
        }
      }
    }
  }

  const handler: ProxyHandler<object> = {
    get(_target: object, domain: string) {
      if (domain in explicitOverrides) {
        return new Proxy(explicitOverrides[domain], {
          get(subTarget, method: string) {
            if (method in subTarget) {
              return subTarget[method]
            }
            return (...args: unknown[]) => invokeTauri(`${domain}_${method}`, { args })
          }
        })
      }

      return new Proxy(
        {},
        {
          get(_subTarget, method: string) {
            if (method.startsWith('on') && method.length > 2) {
              return (callback: (payload: unknown) => void) =>
                subscribeTauri(`${domain}:${method}`, callback)
            }
            return (...args: unknown[]) => invokeTauri(`${domain}_${method}`, { args })
          }
        }
      )
    }
  }

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The dynamic proxy provides transparent runtime dispatch for all PreloadApi domains over Tauri IPC.
  return new Proxy({}, handler) as unknown as PreloadApi
}

export function installTauriPreloadApi(): void {
  if (isTauriEnvironment()) {
    window.api = createTauriPreloadApi()
  }
}
