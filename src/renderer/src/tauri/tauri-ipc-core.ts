import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/**
 * Returns true if the current environment is running inside a Tauri webview.
 */
export function isTauriEnvironment(): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window
}

/**
 * Invokes a Tauri command asynchronously.
 */
export async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args)
}

/**
 * Subscribes to a Tauri event. Safely handles asynchronous unlisten.
 */
export function subscribeTauri<T>(eventName: string, callback: (payload: T) => void): () => void {
  let unlisten: UnlistenFn | null = null
  let disposed = false

  void listen<T>(eventName, (event) => {
    if (!disposed) {
      callback(event.payload)
    }
  }).then((fn) => {
    if (disposed) {
      fn()
    } else {
      unlisten = fn
    }
  })

  return () => {
    disposed = true
    if (unlisten) {
      unlisten()
      unlisten = null
    }
  }
}
