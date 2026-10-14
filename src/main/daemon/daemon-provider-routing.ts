import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import type { IPtyProvider } from '../providers/types'

import { OrcadNativePtyProvider } from '../providers/orcad-native-pty-provider'

export type DaemonProvider =
  | DaemonPtyRouter
  | DaemonPtyAdapter
  | DegradedDaemonPtyProvider
  | OrcadNativePtyProvider

export function getCurrentDaemonAdapter(provider: DaemonProvider): DaemonPtyAdapter | null {
  if (provider instanceof OrcadNativePtyProvider) {
    return null
  }
  if (provider instanceof DaemonPtyRouter || provider instanceof DegradedDaemonPtyProvider) {
    return provider.getCurrentAdapter()
  }
  return provider
}

export function getLegacyDaemonAdapters(provider: IPtyProvider): DaemonPtyAdapter[] {
  if (provider instanceof DaemonPtyRouter || provider instanceof DegradedDaemonPtyProvider) {
    return [...provider.getLegacyAdapters()]
  }
  return []
}

export function disposeProviderSubscriptionsOnly(provider: DaemonProvider): void {
  if (provider instanceof DaemonPtyRouter) {
    provider.disposeRouterOnly()
    return
  }
  if (provider instanceof DegradedDaemonPtyProvider) {
    provider.disposeProviderOnly()
  }
}
