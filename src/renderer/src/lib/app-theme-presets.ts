import type { AppThemePresetId } from '../../../shared/global-settings-types'
import {
  DEFAULT_TERMINAL_THEME_DARK,
  DEFAULT_TERMINAL_THEME_LIGHT
} from '../../../shared/terminal-theme-selection'

export type AppThemePreset = {
  id: AppThemePresetId
  name: string
  mode: 'dark' | 'light'
  description?: string
  swatches: {
    background: string
    card: string
    primary: string
    accent: string
  }
  matchingTerminalTheme?: string
}

export const APP_THEME_PRESETS: readonly AppThemePreset[] = [
  {
    id: 'default',
    name: 'Default (Orca)',
    mode: 'dark',
    description: 'Clean monochrome palette',
    swatches: {
      background: '#0a0a0a',
      card: '#171717',
      primary: '#e5e5e5',
      accent: '#404040'
    },
    matchingTerminalTheme: DEFAULT_TERMINAL_THEME_DARK
  },
  {
    id: 'dracula',
    name: 'Dracula',
    mode: 'dark',
    description: 'Vampire theme with purple & cyan accents',
    swatches: {
      background: '#282a36',
      card: '#343746',
      primary: '#bd93f9',
      accent: '#8be9fd'
    },
    matchingTerminalTheme: 'Dracula'
  },
  {
    id: 'nord',
    name: 'Nord',
    mode: 'dark',
    description: 'Arctic, north-bluish clean palette',
    swatches: {
      background: '#2e3440',
      card: '#3b4252',
      primary: '#88c0d0',
      accent: '#81a1c1'
    },
    matchingTerminalTheme: 'Nord'
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    mode: 'dark',
    description: 'Deep midnight blue with vibrant neon tones',
    swatches: {
      background: '#1a1b26',
      card: '#24283b',
      primary: '#7aa2f7',
      accent: '#bb9af7'
    },
    matchingTerminalTheme: 'Tokyo Night'
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    mode: 'dark',
    description: 'Soothing pastel palette with lavender highlights',
    swatches: {
      background: '#1e1e2e',
      card: '#313244',
      primary: '#cba6f7',
      accent: '#89b4fa'
    },
    matchingTerminalTheme: 'Catppuccin Mocha'
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    mode: 'dark',
    description: 'Low-contrast precision cyan palette',
    swatches: {
      background: '#002b36',
      card: '#073642',
      primary: '#268bd2',
      accent: '#2aa198'
    },
    matchingTerminalTheme: 'Solarized Dark'
  },
  {
    id: 'github-dark',
    name: 'GitHub Dark',
    mode: 'dark',
    description: 'Official GitHub charcoal gray & electric blue',
    swatches: {
      background: '#0d1117',
      card: '#161b22',
      primary: '#58a6ff',
      accent: '#1f6feb'
    },
    matchingTerminalTheme: 'GitHub Dark'
  },
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    mode: 'light',
    description: 'Soft pastel warmth on clean cream surfaces',
    swatches: {
      background: '#eff1f5',
      card: '#e6e9ef',
      primary: '#8839ef',
      accent: '#7287fd'
    },
    matchingTerminalTheme: 'Catppuccin Latte'
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    mode: 'light',
    description: 'Classic warm parchment with high readability',
    swatches: {
      background: '#fdf6e3',
      card: '#eee8d5',
      primary: '#268bd2',
      accent: '#2aa198'
    },
    matchingTerminalTheme: 'Solarized Light'
  },
  {
    id: 'github-light',
    name: 'GitHub Light',
    mode: 'light',
    description: 'Crisp white canvas with classic GitHub blue',
    swatches: {
      background: '#ffffff',
      card: '#f6f8fa',
      primary: '#0969da',
      accent: '#218bff'
    },
    matchingTerminalTheme: 'GitHub Light'
  }
]

const COMPLEMENTARY_THEME_PAIRS: Readonly<Record<AppThemePresetId, AppThemePresetId>> = {
  default: 'default',
  dracula: 'default',
  nord: 'default',
  'tokyo-night': 'default',
  'catppuccin-mocha': 'catppuccin-latte',
  'catppuccin-latte': 'catppuccin-mocha',
  'solarized-dark': 'solarized-light',
  'solarized-light': 'solarized-dark',
  'github-dark': 'github-light',
  'github-light': 'github-dark'
}

/**
 * Resolves the effective UI theme preset based on system preferences and light/dark mode.
 */
export function resolveEffectiveThemePreset(
  baseTheme: 'system' | 'dark' | 'light',
  presetId: AppThemePresetId | undefined,
  systemPrefersDark: boolean
): AppThemePresetId {
  if (!presetId || presetId === 'default') {
    return 'default'
  }

  const isEffectiveDark =
    baseTheme === 'dark' ? true : baseTheme === 'light' ? false : systemPrefersDark

  const selectedPreset = APP_THEME_PRESETS.find((p) => p.id === presetId)
  if (!selectedPreset) {
    return 'default'
  }

  const isPresetDark = selectedPreset.mode === 'dark'
  if (isPresetDark === isEffectiveDark) {
    return presetId
  }

  // Preset mode doesn't match effective dark/light mode; switch to counterpart if available.
  const counterpart = COMPLEMENTARY_THEME_PAIRS[presetId]
  return counterpart ?? 'default'
}

/**
 * Returns the matching terminal color scheme name for an interface theme preset and mode.
 */
export function getMatchingTerminalTheme(
  presetId: AppThemePresetId,
  mode: 'dark' | 'light' = 'dark'
): string | undefined {
  if (presetId === 'default') {
    return mode === 'light' ? DEFAULT_TERMINAL_THEME_LIGHT : DEFAULT_TERMINAL_THEME_DARK
  }
  const preset = APP_THEME_PRESETS.find((p) => p.id === presetId)
  return preset?.matchingTerminalTheme
}
