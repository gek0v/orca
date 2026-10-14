import type { PreloadApi } from '../../../preload/api-types'
import { Channel, invokeTauri, isTauriEnvironment, subscribeTauri } from './tauri-ipc-core'

type PtyData = { id: string; data: string }
type PtyExit = { id: string; code: number }

let cachedSettings: Record<string, unknown> | null = null
const ptyDataListeners = new Set<(data: PtyData) => void>()
const ptyExitListeners = new Set<(data: PtyExit) => void>()

function dispatchPtyEvent<T>(listeners: Set<(payload: T) => void>, payload: T, name: string): void {
  for (const listener of listeners) {
    try {
      listener(payload)
    } catch (err) {
      console.error(`[TauriAdapter] Error in ${name} listener:`, err)
    }
  }
}

const dispatchPtyData = (id: string, data: string) =>
  dispatchPtyEvent(ptyDataListeners, { id, data }, 'pty:onData')
const dispatchPtyExit = (id: string, code: number) =>
  dispatchPtyEvent(ptyExitListeners, { id, code }, 'pty:onExit')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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
      get: async (key?: string) => {
        const result = await invokeTauri<unknown>('settings_get', key ? { key } : undefined)
        if (key) {
          if (isRecord(result) && key in result) {
            cachedSettings = { ...cachedSettings, ...result }
            return result[key]
          }
          cachedSettings = { ...cachedSettings, [key]: result }
          return result
        }
        if (isRecord(result)) {
          cachedSettings = { ...cachedSettings, ...result }
        }
        return result
      },
      getSync: (key?: string) => (key ? (cachedSettings?.[key] ?? null) : cachedSettings),
      set: (args: Record<string, unknown>) => {
        cachedSettings = { ...cachedSettings, ...args }
        return invokeTauri('settings_update', { patch: args })
      }
    },
    opencodeGoCredentials: {
      getStatus: async () => ({
        apiKeyConfigured: Boolean(
          await invokeTauri<string | null>('credentials_get', { account: 'opencode-go' })
        )
      }),
      saveApiKey: async (key: string) => {
        await invokeTauri('credentials_set', { account: 'opencode-go', secret: key })
        return { apiKeyConfigured: true }
      },
      clearApiKey: async () => {
        await invokeTauri('credentials_delete', { account: 'opencode-go' })
        return { apiKeyConfigured: false }
      }
    },
    credentials: {
      get: (service?: string, account?: string) =>
        invokeTauri<string | null>('credentials_get', { service, account }),
      set: (service: string | undefined, account: string, secret: string) =>
        invokeTauri<void>('credentials_set', { service, account, secret }),
      delete: (service: string | undefined, account: string) =>
        invokeTauri<boolean>('credentials_delete', { service, account })
    },
    session: {
      get: async () =>
        (await invokeTauri<Record<string, unknown> | null>('sessions_load')) ?? {
          schemaVersion: 1
        },
      set: (args: unknown) => invokeTauri('sessions_save', { sessions: args })
    },
    orcad: {
      invoke: (method: string, params?: unknown) => invokeTauri('orcad_invoke', { method, params })
    },
    watcher: {
      watch: (watchId: string, path: string) => invokeTauri('watcher_watch', { watchId, path }),
      unwatch: (watchId: string) => invokeTauri('watcher_unwatch', { watchId }),
      onEvents: (callback: (payload: { watchId: string; events: unknown[] }) => void) =>
        subscribeTauri('fs:change', callback)
    },
    ui: {
      minimize: () => void invokeTauri('window_minimize'),
      maximize: () => void invokeTauri('window_toggle_maximize'),
      isMaximized: () => invokeTauri<boolean>('window_is_maximized'),
      requestClose: () => void invokeTauri('window_close'),
      confirmWindowClose: () => void invokeTauri('app_confirm_close_ready'),
      onWindowCloseRequested: (callback: (data: { isQuitting: boolean }) => void) =>
        subscribeTauri<{ isQuitting?: boolean }>('app:prepare-close', (payload) => {
          callback({ isQuitting: payload?.isQuitting ?? false })
        })
    },
    platform: {
      get: () => {
        const nav = typeof navigator !== 'undefined' ? navigator.userAgent : ''
        const isWin = nav.includes('Windows')
        const isMac = nav.includes('Mac')
        return {
          platform: isWin ? 'win32' : isMac ? 'darwin' : 'linux',
          osRelease: '10.0.0',
          arch: 'x64',
          shell: isWin ? 'powershell.exe' : '/bin/bash',
          displayServer: isWin || isMac ? null : 'wayland'
        }
      },
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
        const id = opts.sessionId ?? `pty-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        const isWin = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
        const command = opts.command ?? (isWin ? 'powershell.exe' : '/bin/bash')
        const channel = new Channel<number[] | Uint8Array>()
        const decoder = new TextDecoder('utf-8', { fatal: false })

        channel.onmessage = (raw: number[] | Uint8Array) => {
          const f = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
          if (f.length >= 16 && f[0] === 0x74 && f[1] === 0x01) {
            if (f[2] === 1) {
              const text = decoder.decode(f.subarray(16), { stream: true })
              if (text.length > 0) {
                dispatchPtyData(id, text)
              }
            } else if (f[2] === 2) {
              const dv = new DataView(f.buffer, f.byteOffset, f.byteLength)
              dispatchPtyExit(id, f.length >= 20 ? dv.getUint32(16, true) : (f[16] ?? 0))
            }
          }
        }

        await invokeTauri('pty_spawn', {
          descriptor: {
            session_id: id,
            command,
            args: [],
            cwd: opts.cwd ?? null,
            cols: opts.cols,
            rows: opts.rows
          },
          on_event: channel
        })

        return { id }
      },
      // oxlint-disable-next-line typescript/no-explicit-any -- SAFETY: Alias for pty.spawn accepting various spawn options.
      create: async (opts: any) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Dispatch to spawn method.
        const spawnFn = explicitOverrides.pty.spawn as (o: unknown) => Promise<{ id: string }>
        return spawnFn(opts)
      },
      write: (id: string, data: string, _k?: unknown) => {
        void invokeTauri('pty_write', {
          sessionId: id,
          data: Array.from(new TextEncoder().encode(data))
        })
      },
      writeAccepted: async (id: string, data: string, _k?: unknown) => {
        await invokeTauri('pty_write', {
          sessionId: id,
          data: Array.from(new TextEncoder().encode(data))
        })
        return true
      },
      resize: (id: string, cols: number, rows: number) => {
        void invokeTauri('pty_resize', { sessionId: id, cols, rows })
      },
      kill: async (id: string) => {
        await invokeTauri('pty_kill', { sessionId: id })
      },
      ackData: (_id: string, _charCount: number, _processedChars?: number) => {},
      clearBuffer: (_id: string) => {},
      resetInputModes: (_id: string) => {},
      claimViewport: (_id: string, _cols: number, _rows: number) => {},
      reportGeometry: (_id: string, _cols: number, _rows: number) => {},
      rendererDispatcherReady: () => {},
      onData: (callback: (data: PtyData) => void) => {
        ptyDataListeners.add(callback)
        return () => ptyDataListeners.delete(callback)
      },
      onExit: (callback: (data: PtyExit) => void) => {
        ptyExitListeners.add(callback)
        return () => ptyExitListeners.delete(callback)
      },
      management: {
        listSessions: async () => ({ sessions: [], degraded: false }),
        killAll: async () => ({ killedCount: 0, remainingCount: 0, killedSessionIds: [] }),
        killOne: async () => ({ success: false }),
        restart: async () => ({ success: false }),
        macTccAttribution: async () => ({ health: 'unknown' as const, folderAccessMismatch: null }),
        resetFolderAccess: async () => ({ outcome: 'unsupported' as const })
      }
    }
  }

  const createEventListener =
    (domain: string, method: string) => (callback: (payload: unknown) => void) => {
      try {
        return subscribeTauri(`${domain}:${method}`, callback)
      } catch {
        return () => {}
      }
    }

  const createDomainProxy = (domain: string, target: Record<string, unknown> = {}) =>
    new Proxy(target, {
      get(subTarget, method: string | symbol) {
        if (typeof method !== 'string' || method === 'then') {
          return undefined
        }
        if (method in subTarget) {
          return subTarget[method]
        }
        if (method.startsWith('on') && method.length > 2) {
          return createEventListener(domain, method)
        }
        return (...args: unknown[]) => invokeTauri(`${domain}_${method}`, { args })
      }
    })

  const handler: ProxyHandler<object> = {
    get(_target, domain: string | symbol) {
      if (typeof domain !== 'string' || domain === 'then') {
        return undefined
      }
      return createDomainProxy(domain, explicitOverrides[domain])
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
