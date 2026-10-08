import { removeAgentArgOption } from './agent-session-option-agent-args'
import type { AgentSessionOptionCatalog, CatalogOption } from './agent-session-option-catalog-types'

const ANTIGRAVITY_EFFORT: CatalogOption = {
  id: 'effort',
  label: 'Reasoning effort',
  category: 'thought_level',
  kind: {
    type: 'select',
    choices: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' }
    ],
    defaultValue: 'high'
  },
  apply: {
    launchArgs: (value) => ['--effort', String(value)],
    removeAgentArgs: (tokens) => removeAgentArgOption('antigravity', tokens, ['--effort']),
    midSession: { kind: 'command', build: (value) => `/effort ${String(value)}` }
  }
}

export const ANTIGRAVITY_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  models: [
    {
      id: 'gemini-2.5-pro',
      label: 'Gemini 2.5 Pro',
      description: 'Most capable model for complex coding and reasoning tasks',
      isDefault: true,
      options: [ANTIGRAVITY_EFFORT]
    },
    {
      id: 'gemini-2.5-flash',
      label: 'Gemini 2.5 Flash',
      description: 'Fast, lightweight model for routine development tasks',
      options: [ANTIGRAVITY_EFFORT]
    },
    {
      id: 'gemini-3.1-pro-high',
      label: 'Gemini 3.1 Pro (Thinking)',
      description: 'Deep reasoning model for challenging algorithmic problems',
      options: [ANTIGRAVITY_EFFORT]
    },
    {
      id: 'claude-3-7-sonnet',
      label: 'Claude 3.7 Sonnet',
      description: 'High-capability hybrid reasoning model via Antigravity',
      options: [ANTIGRAVITY_EFFORT]
    }
  ],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    removeAgentArgs: (tokens) => removeAgentArgOption('antigravity', tokens, ['--model']),
    midSession: { kind: 'agent-picker', command: '/model' }
  },
  unknownModelOptions: [ANTIGRAVITY_EFFORT]
}
