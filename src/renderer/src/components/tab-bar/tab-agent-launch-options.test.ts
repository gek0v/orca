import { describe, expect, it } from 'vitest'
import { ALL_TUI_AGENTS } from '../../../../shared/tui-agent-display-names'
import { isTuiAgent, TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import { getAgentCatalog, getAgentLabel } from '../../lib/agent-catalog'
import { agentKindForAgentType, agentTypeToIconAgent } from '../../lib/agent-status'
import {
  buildTabAgentLaunchOptions,
  findMatchingTabAgentLaunchOptions,
  orderTabLaunchAgents
} from './tab-agent-launch-options'

describe('tab agent launch options', () => {
  it('orders detected agents by the configured default first', () => {
    expect(orderTabLaunchAgents('codex', ['claude', 'codex', 'gemini'])).toEqual([
      'codex',
      'claude',
      'gemini'
    ])
  })

  it('excludes disabled agents from the launch list', () => {
    expect(orderTabLaunchAgents(null, ['claude', 'codex', 'openclaude'], ['openclaude'])).toEqual([
      'claude',
      'codex'
    ])
  })

  it('labels DeepSeek Build without offering it in the launch catalog', () => {
    expect(getAgentLabel('dsb')).toBe('DeepSeek Build')
    expect(agentTypeToIconAgent('dsb')).toBe('dsb')
    expect(agentKindForAgentType('dsb')).toBe('other')
    expect(isTuiAgent('dsb')).toBe(false)
    expect(Object.hasOwn(TUI_AGENT_CONFIG, 'dsb')).toBe(false)
    expect(ALL_TUI_AGENTS).not.toContain('dsb')
    expect(getAgentCatalog().map((entry) => entry.id)).not.toContain('dsb')
  })
  it('drops a disabled default agent instead of surfacing it first', () => {
    const ordered = orderTabLaunchAgents(
      'openclaude',
      ['claude', 'codex', 'openclaude'],
      ['openclaude']
    )
    expect(ordered).not.toContain('openclaude')
    expect(ordered).toEqual(['claude', 'codex'])
  })

  it('keeps a disabled agent out of new-tab search results', () => {
    const options = buildTabAgentLaunchOptions(
      orderTabLaunchAgents('codex', ['claude', 'codex', 'openclaude'], ['openclaude'])
    )
    expect(findMatchingTabAgentLaunchOptions('open', options).map((o) => o.agent)).toEqual([])
  })

  it('matches detected agents by id, label, command, and command override', () => {
    const options = buildTabAgentLaunchOptions(['claude', 'codex', 'antigravity'], {
      codex: 'codex-beta'
    })

    expect(
      findMatchingTabAgentLaunchOptions('Claude', options).map((option) => option.agent)
    ).toEqual(['claude'])
    expect(findMatchingTabAgentLaunchOptions('openai codex', options)).toEqual([])
    expect(
      findMatchingTabAgentLaunchOptions('codex-beta', options).map((option) => option.agent)
    ).toEqual(['codex'])
    expect(findMatchingTabAgentLaunchOptions('agy', options).map((option) => option.agent)).toEqual(
      ['antigravity']
    )
  })

  it('matches agents on a partial prefix so the launcher actually searches', () => {
    const options = buildTabAgentLaunchOptions(['claude', 'codex', 'gemini', 'antigravity'])

    // Each is one character short of the full agent name.
    expect(findMatchingTabAgentLaunchOptions('gemin', options).map((o) => o.agent)).toEqual([
      'gemini'
    ])
    expect(findMatchingTabAgentLaunchOptions('clau', options).map((o) => o.agent)).toEqual([
      'claude'
    ])
    expect(findMatchingTabAgentLaunchOptions('anti', options).map((o) => o.agent)).toEqual([
      'antigravity'
    ])
  })

  it('ranks an exact alias above weaker prefix matches', () => {
    const options = buildTabAgentLaunchOptions(['codex', 'copilot', 'codebuff'])

    // "co" prefixes all three; "codex" exactly matches one and must lead.
    expect(findMatchingTabAgentLaunchOptions('codex', options)[0]?.agent).toBe('codex')
    expect(findMatchingTabAgentLaunchOptions('co', options).map((o) => o.agent)).toEqual(
      expect.arrayContaining(['codex', 'copilot', 'codebuff'])
    )
  })

  it('does not match on a mid-string substring that would hijack file results', () => {
    const options = buildTabAgentLaunchOptions(['opencode', 'claude'])

    // "ode" is inside "opencode" but not a prefix — agents rank above files, so
    // a noisy mid-string hit must not surface.
    expect(findMatchingTabAgentLaunchOptions('ode', options)).toEqual([])
  })

  it('requires at least two characters before a prefix matches (no single-key flood)', () => {
    const options = buildTabAgentLaunchOptions(['claude', 'codex', 'copilot', 'cursor'])

    // A lone "c" must not surface (and auto-launch) an agent.
    expect(findMatchingTabAgentLaunchOptions('c', options)).toEqual([])
    // Two characters is enough to start searching.
    expect(findMatchingTabAgentLaunchOptions('co', options).map((o) => o.agent)).toEqual(
      expect.arrayContaining(['codex', 'copilot'])
    )
  })

  it('builds launch options for each Antigravity account when accounts are provided', () => {
    const accounts = [
      { id: 'acc-work', alias: 'Work', email: 'work@example.com' },
      { id: 'acc-personal', alias: 'Personal', email: 'personal@example.com' }
    ]
    const options = buildTabAgentLaunchOptions(['claude', 'antigravity'], {}, accounts)

    const antigravityOptions = options.filter((o) => o.agent === 'antigravity')
    expect(antigravityOptions).toHaveLength(2)
    expect(antigravityOptions[0]?.accountId).toBe('acc-work')
    expect(antigravityOptions[0]?.label).toBe('Antigravity (Work)')
    expect(antigravityOptions[1]?.accountId).toBe('acc-personal')
    expect(antigravityOptions[1]?.label).toBe('Antigravity (Personal)')
  })

  it('matches Antigravity account options by account alias, email, and agent name', () => {
    const accounts = [
      { id: 'acc-work', alias: 'Work', email: 'work@example.com' },
      { id: 'acc-personal', alias: 'Personal', email: 'personal@example.com' }
    ]
    const options = buildTabAgentLaunchOptions(['antigravity', 'claude'], {}, accounts)

    expect(findMatchingTabAgentLaunchOptions('work', options).map((o) => o.accountId)).toEqual([
      'acc-work'
    ])
    expect(findMatchingTabAgentLaunchOptions('personal', options).map((o) => o.accountId)).toEqual([
      'acc-personal'
    ])
    expect(findMatchingTabAgentLaunchOptions('agy', options).map((o) => o.accountId)).toEqual([
      'acc-work',
      'acc-personal'
    ])
    expect(
      findMatchingTabAgentLaunchOptions('antigravity', options).map((o) => o.accountId)
    ).toEqual(['acc-work', 'acc-personal'])
  })

  it('falls back to single default Antigravity option when accounts list is empty or omitted', () => {
    const optionsEmpty = buildTabAgentLaunchOptions(['antigravity'], {}, [])
    expect(optionsEmpty).toHaveLength(1)
    expect(optionsEmpty[0]?.agent).toBe('antigravity')
    expect(optionsEmpty[0]?.accountId).toBeUndefined()
    expect(optionsEmpty[0]?.label).toBe('Antigravity')

    const optionsOmitted = buildTabAgentLaunchOptions(['antigravity'])
    expect(optionsOmitted).toHaveLength(1)
    expect(optionsOmitted[0]?.accountId).toBeUndefined()
  })

  it('labels Antigravity account option with email when alias is not set', () => {
    const accounts = [{ id: 'acc-anon', email: 'developer@company.org' }]
    const options = buildTabAgentLaunchOptions(['antigravity'], {}, accounts)

    expect(options[0]?.label).toBe('Antigravity (developer@company.org)')
    expect(findMatchingTabAgentLaunchOptions('developer', options).map((o) => o.accountId)).toEqual(
      ['acc-anon']
    )
  })
})
