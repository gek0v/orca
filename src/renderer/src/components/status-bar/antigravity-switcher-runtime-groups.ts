import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  getStatusBarPreferredWslDistro,
  shouldIncludeSettingsWslRuntime,
  type CodexStatusSwitchGroup
} from './status-bar-runtime-targets'

export function buildAntigravitySwitchGroups(
  settings: GlobalSettings | null | undefined,
  wslDistros: string[],
  isWindows: boolean
): CodexStatusSwitchGroup[] {
  const hostLabel = isWindows ? 'Windows' : 'This device'
  const fallbackWslDistro = getStatusBarPreferredWslDistro(settings, wslDistros)
  const groups: CodexStatusSwitchGroup[] = [
    {
      key: 'host',
      label: hostLabel,
      runtimeTarget: { runtime: 'host', wslDistro: null },
      targets: []
    }
  ]
  if (wslDistros.length > 0) {
    for (const distro of wslDistros) {
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
