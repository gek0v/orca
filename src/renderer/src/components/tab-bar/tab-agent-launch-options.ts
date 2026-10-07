import { getAgentCatalog } from '@/lib/agent-catalog'
import { filterEnabledTuiAgents } from '../../../../shared/tui-agent-selection'
import { normalizeMatchQuery, tokenizeMatchValue } from './query-token-match'
import type { TuiAgent } from '../../../../shared/tui-agent'

export type TabAgentLaunchOption = {
  agent: TuiAgent
  aliases: readonly string[]
  label: string
  accountId?: string
  launchAccountId?: string
}

export type TabAgentAntigravityAccount = {
  id: string
  alias?: string | null
  email?: string | null
  subject?: string | null
  color?: string | null
  emoji?: string | null
}

function normalizeAgentAlias(value: string): string {
  return value.trim().toLowerCase()
}

function compactAgentAlias(value: string): string {
  return normalizeAgentAlias(value).replace(/[\s_-]+/g, '')
}

function getCatalogEntry(agent: TuiAgent): { id: TuiAgent; label: string; cmd: string } | null {
  return getAgentCatalog().find((entry) => entry.id === agent) ?? null
}

export function orderTabLaunchAgents(
  defaultAgent: TuiAgent | 'blank' | null | undefined,
  detected: readonly TuiAgent[],
  disabled?: Iterable<unknown> | null
): TuiAgent[] {
  const enabledDetected = filterEnabledTuiAgents(detected, disabled)
  const inCatalogOrder = getAgentCatalog()
    .filter((entry) => enabledDetected.includes(entry.id))
    .map((entry) => entry.id)
  if (!defaultAgent || defaultAgent === 'blank' || !inCatalogOrder.includes(defaultAgent)) {
    return inCatalogOrder
  }
  return [defaultAgent, ...inCatalogOrder.filter((id) => id !== defaultAgent)]
}

function isAccountList(value: unknown): value is readonly TabAgentAntigravityAccount[] {
  return Array.isArray(value)
}

function isOptionsBag(value: unknown): value is {
  commandOverrides?: Partial<Record<TuiAgent, string>>
  antigravityAccounts?: readonly TabAgentAntigravityAccount[] | null
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('antigravityAccounts' in value || 'commandOverrides' in value)
  )
}

export function buildTabAgentLaunchOptions(
  agents: readonly TuiAgent[],
  commandOverridesOrAccounts?:
    | Partial<Record<TuiAgent, string>>
    | readonly TabAgentAntigravityAccount[]
    | {
        commandOverrides?: Partial<Record<TuiAgent, string>>
        antigravityAccounts?: readonly TabAgentAntigravityAccount[] | null
      },
  antigravityAccounts?: readonly TabAgentAntigravityAccount[] | null
): TabAgentLaunchOption[] {
  const commandOverrides: Partial<Record<TuiAgent, string>> = isAccountList(
    commandOverridesOrAccounts
  )
    ? {}
    : isOptionsBag(commandOverridesOrAccounts)
      ? (commandOverridesOrAccounts.commandOverrides ?? {})
      : (commandOverridesOrAccounts ?? {})

  const accounts: readonly TabAgentAntigravityAccount[] | null = isAccountList(
    commandOverridesOrAccounts
  )
    ? commandOverridesOrAccounts
    : isOptionsBag(commandOverridesOrAccounts)
      ? (commandOverridesOrAccounts.antigravityAccounts ?? null)
      : (antigravityAccounts ?? null)

  return agents.flatMap((agent) => {
    const entry = getCatalogEntry(agent)
    const baseLabel = entry?.label ?? agent
    const baseAliases = new Set<string>([
      normalizeAgentAlias(agent),
      normalizeAgentAlias(baseLabel),
      compactAgentAlias(agent),
      compactAgentAlias(baseLabel)
    ])
    if (entry?.cmd) {
      baseAliases.add(normalizeAgentAlias(entry.cmd))
      baseAliases.add(compactAgentAlias(entry.cmd))
    }
    const commandOverride = commandOverrides[agent]?.trim()
    if (commandOverride) {
      baseAliases.add(normalizeAgentAlias(commandOverride))
      baseAliases.add(compactAgentAlias(commandOverride))
    }

    if (agent === 'antigravity' && accounts && accounts.length > 0) {
      return accounts.map((acc) => {
        const accountName = acc.alias?.trim() || acc.email?.trim() || acc.subject?.trim()
        const label = accountName ? `${baseLabel} (${accountName})` : baseLabel
        const aliases = new Set<string>(baseAliases)
        if (acc.alias?.trim()) {
          aliases.add(normalizeAgentAlias(acc.alias))
          aliases.add(compactAgentAlias(acc.alias))
        }
        if (acc.email?.trim()) {
          aliases.add(normalizeAgentAlias(acc.email))
          aliases.add(compactAgentAlias(acc.email))
          const emailPrefix = acc.email.split('@')[0]
          if (emailPrefix) {
            aliases.add(normalizeAgentAlias(emailPrefix))
            aliases.add(compactAgentAlias(emailPrefix))
          }
        }
        if (acc.subject?.trim()) {
          aliases.add(normalizeAgentAlias(acc.subject))
          aliases.add(compactAgentAlias(acc.subject))
        }
        aliases.add(normalizeAgentAlias(label))
        aliases.add(compactAgentAlias(label))

        return {
          agent,
          aliases: [...aliases],
          label,
          accountId: acc.id,
          launchAccountId: acc.id
        }
      })
    }

    return [
      {
        agent,
        aliases: [...baseAliases],
        label: baseLabel
      }
    ]
  })
}

// Scores how well a query matches an agent. Exact alias equality is the
// strongest signal; otherwise every query token must prefix some alias token.
// Why prefix-only (not substring): agent rows rank above file matches, so a
// mid-string match like "ode" → "opencode" would noisily hijack the list.
function scoreAgentLaunchOption(
  normalizedQuery: string,
  compactQuery: string,
  option: TabAgentLaunchOption
): number {
  if (option.aliases.includes(normalizedQuery) || option.aliases.includes(compactQuery)) {
    return 1000
  }
  const candidateTokens = option.aliases.flatMap(tokenizeMatchValue)
  const queryTokens = tokenizeMatchValue(normalizedQuery)
  if (queryTokens.length === 0 || candidateTokens.length === 0) {
    return 0
  }
  let score = 0
  for (const queryToken of queryTokens) {
    let best = 0
    for (const candidateToken of candidateTokens) {
      if (candidateToken === queryToken) {
        best = Math.max(best, 3)
      } else if (queryToken.length >= 2 && candidateToken.startsWith(queryToken)) {
        // Why: a single-character prefix matches almost every agent, flooding the
        // list and letting one keystroke auto-launch the wrong agent; require an
        // exact token match below 2 chars.
        best = Math.max(best, 2)
      }
    }
    if (best === 0) {
      return 0
    }
    score += best
  }
  return score
}

export function findMatchingTabAgentLaunchOptions(
  query: string,
  agents: readonly TabAgentLaunchOption[]
): TabAgentLaunchOption[] {
  const normalizedQuery = normalizeMatchQuery(query)
  if (!normalizedQuery) {
    return []
  }
  const compactQuery = compactAgentAlias(query)
  return agents
    .map((option, index) => ({
      index,
      option,
      score: scoreAgentLaunchOption(normalizedQuery, compactQuery, option)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      left.score !== right.score ? right.score - left.score : left.index - right.index
    )
    .map((entry) => entry.option)
}
