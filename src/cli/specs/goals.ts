import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const GOALS_COMMAND_SPEC: CommandSpec = {
  path: ['goal'],
  summary: 'Manage worktree goals and subtasks',
  usage: 'orca goal <status|set|complete|validate|add-task> [args] [--worktree <path>] [--json]',
  allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'json'],
  notes: [
    'Operates on .orca/goals.json in the current or specified worktree.',
    'Updates .orca/CURRENT_GOAL.md projection on mutation.'
  ],
  examples: [
    'orca goal status',
    'orca goal set "Implement AI goal generator"',
    'orca goal complete 1',
    'orca goal validate',
    'orca goal add-task "Implement feature"'
  ]
}

export const GOAL_STATUS_COMMAND_SPEC: CommandSpec = {
  path: ['goal', 'status'],
  summary: 'Show active goal status and subtasks',
  usage: 'orca goal status [--worktree <path>] [--json]',
  allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'json'],
  examples: ['orca goal status', 'orca goal status --json']
}

export const GOAL_COMPLETE_COMMAND_SPEC: CommandSpec = {
  path: ['goal', 'complete'],
  summary: 'Complete a subtask by ID or 1-based index in the active goal',
  usage: 'orca goal complete <id-or-index> [--worktree <path>] [--json]',
  allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'json', 'id-or-index'],
  positionalArgs: ['id-or-index'],
  examples: ['orca goal complete 1', 'orca goal complete task-1']
}

export const GOAL_VALIDATE_COMMAND_SPEC: CommandSpec = {
  path: ['goal', 'validate'],
  summary: 'Run validation command for the active goal',
  usage: 'orca goal validate [--worktree <path>] [--json]',
  allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'json'],
  examples: ['orca goal validate']
}

export const GOAL_ADD_TASK_COMMAND_SPEC: CommandSpec = {
  path: ['goal', 'add-task'],
  summary: 'Add a new subtask to the active goal',
  usage: 'orca goal add-task <title> [--worktree <path>] [--json]',
  allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'json', 'title'],
  positionalArgs: ['title'],
  examples: ['orca goal add-task "Write unit tests"']
}

export const GOAL_SET_COMMAND_SPEC: CommandSpec = {
  path: ['goal', 'set'],
  summary: 'Set a new active goal for the workspace',
  usage:
    'orca goal set <title> [--description <desc>] [--validation <cmd>] [--worktree <path>] [--json]',
  allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'json', 'title', 'description', 'validation'],
  positionalArgs: ['title'],
  examples: [
    'orca goal set "Implement AI goal generator"',
    'orca goal set "Fix login bug" --validation "pnpm test"'
  ]
}

export const GOAL_CREATE_COMMAND_SPEC: CommandSpec = {
  path: ['goal', 'create'],
  summary: 'Create and set a new active goal for the workspace',
  usage:
    'orca goal create <title> [--description <desc>] [--validation <cmd>] [--worktree <path>] [--json]',
  allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'json', 'title', 'description', 'validation'],
  positionalArgs: ['title'],
  examples: ['orca goal create "Implement AI goal generator"']
}

export const GOALS_COMMAND_SPECS: CommandSpec[] = [
  GOALS_COMMAND_SPEC,
  GOAL_STATUS_COMMAND_SPEC,
  GOAL_SET_COMMAND_SPEC,
  GOAL_CREATE_COMMAND_SPEC,
  GOAL_COMPLETE_COMMAND_SPEC,
  GOAL_VALIDATE_COMMAND_SPEC,
  GOAL_ADD_TASK_COMMAND_SPEC
]
