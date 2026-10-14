import type { PreloadApi } from '../../../../preload/api-types'
import { invokeTauri, isTauriEnvironment, subscribeTauri } from './tauri-ipc-core'

let cachedSettings: Record<string, unknown> | null = null

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
      getSync: () => cachedSettings ?? {},
      update: (patch: Record<string, unknown>) => {
        cachedSettings = { ...cachedSettings, ...patch }
        return invokeTauri('settings_update', { patch })
      }
    },
    ui: {
      minimize: () => invokeTauri<void>('window_minimize'),
      toggleMaximize: () => invokeTauri<void>('window_toggle_maximize'),
      close: () => invokeTauri<void>('window_close'),
      isMaximized: () => invokeTauri<boolean>('window_is_maximized')
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
