import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const GOALS_COMMAND_SPEC: CommandSpec = {
  path: ['goal'],
  summary: 'Manage worktree goals and subtasks',
  usage: 'orca goal <status|complete|validate|add-task> [args] [--worktree <path>] [--json]',
  allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'json'],
  notes: [
    'Operates on .orca/goals.json in the current or specified worktree.',
    'Updates .orca/CURRENT_GOAL.md projection on mutation.'
  ],
  examples: [
    'orca goal status',
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

export const GOALS_COMMAND_SPECS: CommandSpec[] = [
  GOALS_COMMAND_SPEC,
  GOAL_STATUS_COMMAND_SPEC,
  GOAL_COMPLETE_COMMAND_SPEC,
  GOAL_VALIDATE_COMMAND_SPEC,
  GOAL_ADD_TASK_COMMAND_SPEC
]
