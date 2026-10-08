import { describe, expect, it } from 'vitest'
import {
  applySlashSuggestion,
  filterSlashCommands,
  getAgentSlashCommands,
  isSlashCommandDraft,
  sessionReportedSkillNames,
  sessionSlashCommandSuggestions,
  slashCommandDispatchText
} from './native-chat-slash-commands'

describe('getAgentSlashCommands', () => {
  it('returns Codex-specific commands (e.g. /model, /resume) for codex', () => {
    const names = getAgentSlashCommands('codex').map((c) => c.name)
    expect(names).toContain('model')
    expect(names).toContain('resume')
    expect(names).toContain('diff')
  })

  it('returns Claude commands for claude (no Codex-only /model)', () => {
    const names = getAgentSlashCommands('claude').map((c) => c.name)
    expect(names).toContain('clear')
    expect(names).toContain('compact')
    expect(names).not.toContain('model')
    // Claude's terminal writes no /context reply the chat could show.
    expect(names).not.toContain('context')
  })

  it('offers OpenClaude /context, whose report lands in its transcript', () => {
    const names = getAgentSlashCommands('openclaude').map((c) => c.name)
    expect(names).toEqual([...getAgentSlashCommands('claude').map((c) => c.name), 'context'])
  })

  it('returns Antigravity commands (e.g. /model, /effort, /usage, /skills, /subagents) for antigravity', () => {
    const names = getAgentSlashCommands('antigravity').map((c) => c.name)
    expect(names).toContain('model')
    expect(names).toContain('effort')
    expect(names).toContain('usage')
    expect(names).toContain('plan')
    expect(names).toContain('skills')
    expect(names).toContain('subagents')
    expect(names).toContain('mcp')
    expect(names).toContain('diff')
    expect(names).toContain('init')
    expect(names).toContain('auth')
    expect(names).toContain('browser')
    expect(names).toContain('schedule')
  })

  it('falls back to a small common set for an unknown agent (never empty)', () => {
    const names = getAgentSlashCommands('some-other-agent').map((c) => c.name)
    expect(names).toEqual(['clear', 'help'])
  })
})

describe('isSlashCommandDraft', () => {
  it('is true for a leading slash, even with leading whitespace', () => {
    expect(isSlashCommandDraft('/clear')).toBe(true)
    expect(isSlashCommandDraft('  /model')).toBe(true)
  })

  it('is false for ordinary prose or a mid-line slash', () => {
    expect(isSlashCommandDraft('fix the bug')).toBe(false)
    expect(isSlashCommandDraft('run a/b test')).toBe(false)
    expect(isSlashCommandDraft('')).toBe(false)
  })
})

describe('filterSlashCommands', () => {
  const codex = getAgentSlashCommands('codex')

  it('returns all commands for an empty query (bare /)', () => {
    expect(filterSlashCommands(codex, '')).toHaveLength(codex.length)
  })

  it('prefix-matches case-insensitively', () => {
    const names = filterSlashCommands(codex, 'mod').map((c) => c.name)
    expect(names).toEqual(['model'])
    expect(filterSlashCommands(codex, 'MOD').map((c) => c.name)).toEqual(['model'])
  })
})

describe('dispatch vs completion text', () => {
  it('dispatch text has no trailing space (Enter dispatches the command)', () => {
    expect(slashCommandDispatchText({ name: 'clear' })).toBe('/clear')
  })

  it('completion text has a trailing space (Tab completes for arguments)', () => {
    expect(applySlashSuggestion({ name: 'model' })).toBe('/model ')
  })
})

describe('a session that reports its own command surface', () => {
  const reported = [
    { name: 'clear', kind: 'command' as const },
    { name: 'opsx:apply', kind: 'command' as const },
    { name: 'ref-oss', kind: 'skill' as const }
  ]

  it('merges reported commands with curated commands containing plan, logout, model, effort, usage, clear', () => {
    const antigravityReported = [
      { name: 'plan', kind: 'command' as const, description: 'Switch to planning mode' },
      { name: 'logout', kind: 'command' as const, description: 'Log out of account' }
    ]
    const suggestions = sessionSlashCommandSuggestions('antigravity', antigravityReported)
    const names = suggestions.map((c) => c.name)
    expect(names).toContain('plan')
    expect(names).toContain('logout')
    expect(names).toContain('model')
    expect(names).toContain('effort')
    expect(names).toContain('usage')
    expect(names).toContain('clear')
    expect(names).toContain('goal')
    expect(names).toContain('skills')
    expect(names).toContain('mcp')
  })

  it('overrides curated description when reported command has matching name', () => {
    const suggestions = sessionSlashCommandSuggestions('antigravity', [
      { name: 'plan', kind: 'command', description: 'Custom ACP plan mode' }
    ])
    const planCommand = suggestions.find((c) => c.name === 'plan')
    expect(planCommand?.description).toBe('Custom ACP plan mode')
    const modelCommand = suggestions.find((c) => c.name === 'model')
    expect(modelCommand?.description).toBe('Choose the model')
  })

  it('merges reported commands with curated catalog and fills in missing descriptions', () => {
    const suggestions = sessionSlashCommandSuggestions('claude', reported)
    expect(suggestions.find((c) => c.name === 'clear')).toEqual({
      name: 'clear',
      description: 'Clear conversation history'
    })
    expect(suggestions.find((c) => c.name === 'opsx:apply')).toEqual({
      name: 'opsx:apply'
    })
    const names = suggestions.map((c) => c.name)
    expect(names).toContain('compact')
    expect(names).toContain('init')
    expect(names).toContain('review')
    expect(names).toContain('help')
  })

  it('splits skills out for the picker to group on its own', () => {
    expect(sessionReportedSkillNames(reported)).toEqual(['ref-oss'])
  })

  it('prefers the description the session reported over the curated one', () => {
    const suggestions = sessionSlashCommandSuggestions('claude', [
      { name: 'clear', kind: 'command', description: 'Wipe the transcript' },
      { name: 'goal', kind: 'command', description: 'Set or view the goal' },
      { name: 'compact', kind: 'command' }
    ])
    expect(suggestions.find((c) => c.name === 'clear')).toEqual({
      name: 'clear',
      description: 'Wipe the transcript'
    })
    expect(suggestions.find((c) => c.name === 'goal')).toEqual({
      name: 'goal',
      description: 'Set or view the goal'
    })
    expect(suggestions.find((c) => c.name === 'compact')).toEqual({
      name: 'compact',
      description: 'Summarize and compact the conversation'
    })
    expect(suggestions.map((c) => c.name)).toContain('init')
  })

  it('keeps a reported description and argument hint the curated catalog never claims', () => {
    const suggestions = sessionSlashCommandSuggestions('codex', [
      {
        name: 'opsx:apply',
        kind: 'command',
        description: 'Apply the plan',
        argumentHint: '<plan-id>',
        kindUnspecified: true
      }
    ])
    expect(suggestions.find((c) => c.name === 'opsx:apply')).toEqual({
      name: 'opsx:apply',
      description: 'Apply the plan',
      argumentHint: '<plan-id>',
      kindUnspecified: true
    })
    expect(suggestions.map((c) => c.name)).toContain('model')
  })
})
