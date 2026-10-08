// How Orca starts each ACP agent, as data: adding an agent is one more row (plus a dialect when it
// speaks protocol extensions). Nothing outside `acp-dialects/` branches on an agent's name.

import { join } from 'node:path'
import {
  ORCA_SCRUB_SAFE_LAUNCH_ENV,
  ORCA_SCRUB_SAFE_PANE_ENV
} from '../../shared/agent-hook-scrub-safe-env'
import { AGENT_HOOK_RUNTIME_ENV_KEYS } from '../ipc/pty/host-env/spawn-env-keys'
import type { AcpDialect } from './acp-dialects/acp-dialect'
import { GROK_ACP_DIALECT } from './acp-dialects/grok-dialect'
import { ANTIGRAVITY_ACP_DIALECT } from './acp-dialects/antigravity-dialect'
import {
  ensureAntigravityAcpRuntime,
  getAntigravityManagedInstallDir,
  resolveAntigravityAcpBinary
} from './runtime/antigravity-runtime-manager'

export type AcpLaunchSpec = {
  /** The Orca agent id (a `TuiAgent`), which names the agent's records and its catalog label. */
  agent: string
  command: string
  /** Built per launch: `fullAccess` is the Agent Permissions setting's bypass posture. */
  args(input: { fullAccess: boolean }): string[]
  /** Overlaid on the child's environment. */
  env: Readonly<Record<string, string>>
  dialect: AcpDialect
  /** The agent's own sign-in command, for a person to run when it reports auth required. */
  loginCommand: readonly string[]
  /** Which advertised sign-in method to use when the agent reports auth required, read from the
   *  environment it was launched with (on its own machine); none leaves it not signed in. */
  authMethod?(input: {
    advertised: readonly string[]
    env: Readonly<Record<string, string>>
  }): string | undefined
  /** Variable naming the agent's config directory, pinned as each record's account home. */
  accountHomeVariable: string
  /** The config directory the agent uses when the variable is unset, under the user's home. */
  defaultAccountHome(homePath: string): string
  /** Where the agent installs its own binary, searched after PATH. */
  installDirectories(accountHomePath: string, homePath?: string): string[]
  /** Custom binary resolver checked before standard CLI resolution. */
  resolveCommand?(input: {
    command: string
    pathEnv: string
    homePath: string
    env: Readonly<Record<string, string>>
  }): Promise<string | null> | string | null
}

const GROK_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'grok',
  command: 'grok',
  // `--always-approve` only for full access, as the user's setting chooses.
  args: ({ fullAccess }) => ['agent', ...(fullAccess ? ['--always-approve'] : []), 'stdio'],
  env: {},
  dialect: GROK_ACP_DIALECT,
  loginCommand: ['grok', 'login'],
  // An API key in Grok's own environment, else the sign-in Grok already cached; never interactive.
  authMethod: ({ advertised, env }) =>
    env.XAI_API_KEY?.trim() && advertised.includes('xai.api_key')
      ? 'xai.api_key'
      : advertised.includes('cached_token')
        ? 'cached_token'
        : undefined,
  accountHomeVariable: 'GROK_HOME',
  defaultAccountHome: (homePath) => join(homePath, '.grok'),
  installDirectories: (accountHomePath) => [join(accountHomePath, 'bin')]
}

export const ANTIGRAVITY_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'antigravity',
  command: 'agy_acp_server',
  args: () => [],
  env: {},
  dialect: ANTIGRAVITY_ACP_DIALECT,
  loginCommand: ['agy'],
  authMethod: ({ advertised, env }) => {
    const hasApiKey = Boolean(env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim())
    if (hasApiKey && advertised.includes('gemini-api-key')) {
      return 'gemini-api-key'
    }
    if (advertised.includes('cached_token')) {
      return 'cached_token'
    }
    if (advertised.includes('oauth-personal')) {
      return 'oauth-personal'
    }
    return undefined
  },
  accountHomeVariable: 'GEMINI_ACP_HOME',
  defaultAccountHome: (homePath) => join(homePath, '.gemini', 'antigravity-acp'),
  installDirectories: (accountHomePath, homePath) => {
    const dirs = [join(accountHomePath, 'bin'), join(accountHomePath, 'current')]
    if (homePath) {
      const localAppData = process.env.LOCALAPPDATA ?? join(homePath, 'AppData', 'Local')
      dirs.push(
        getAntigravityManagedInstallDir(homePath),
        join(homePath, '.local', 'bin'),
        join(localAppData, 'agy', 'bin')
      )
    }
    return dirs
  },
  resolveCommand: async ({ env, homePath }) => {
    const existing = resolveAntigravityAcpBinary({
      env,
      homePath,
      platform: process.platform
    })
    if (existing) {
      return existing.command
    }
    try {
      return await ensureAntigravityAcpRuntime({
        homePath,
        platform: process.platform,
        arch: process.arch
      })
    } catch {
      return null
    }
  }
}

export const ACP_LAUNCH_SPECS: readonly AcpLaunchSpec[] = [
  GROK_LAUNCH_SPEC,
  ANTIGRAVITY_LAUNCH_SPEC
]

export function acpLaunchSpecFor(agent: string): AcpLaunchSpec | null {
  return ACP_LAUNCH_SPECS.find((spec) => spec.agent === agent) ?? null
}

/**
 * A pane's identity in the inherited environment would let the agent's own Orca status hooks
 * report for this session too; the structured session is its one status producer.
 */
export const ACP_CHILD_ENV_TO_DELETE: readonly string[] = [
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_AGENT_LAUNCH_TOKEN',
  ORCA_SCRUB_SAFE_PANE_ENV,
  ORCA_SCRUB_SAFE_LAUNCH_ENV,
  ...AGENT_HOOK_RUNTIME_ENV_KEYS
]
