import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  getStatusBarPreferredWslDistro,
  shouldIncludeSettingsWslRuntime,
  type CodexStatusSwitchGroup
} from './status-bar-runtime-targets'

export function buildAntigravitySwitchGroups(
  settings: GlobalSettings | null | undefined,
  wslDistros: string[] = [],
  isWindows: boolean
): CodexStatusSwitchGroup[] {
  const hostLabel = isWindows ? 'Windows' : 'This device'
  const distros = Array.isArray(wslDistros) ? wslDistros : []
  const fallbackWslDistro = getStatusBarPreferredWslDistro(settings, distros)
  const groups: CodexStatusSwitchGroup[] = [
    {
      key: 'host',
      label: hostLabel,
      runtimeTarget: { runtime: 'host', wslDistro: null },
      targets: []
    }
  ]
  if (distros.length > 0) {
    for (const distro of distros) {
      groups.push({
        key: `wsl:${distro}`,
        label: `WSL ${distro}`,
        runtimeTarget: { runtime: 'wsl', wslDistro: distro },
        targets: []
      })
    }
  } else if (shouldIncludeSettingsWslRuntime(settings) && fallbackWslDistro) {
    groups.push({
      key: `wsl:${fallbackWslDistro}`,
      label: `WSL ${fallbackWslDistro}`,
      runtimeTarget: { runtime: 'wsl', wslDistro: fallbackWslDistro },
      targets: []
    })
  }
  return groups
}
