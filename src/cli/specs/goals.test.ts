import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  GOALS_COMMAND_SPEC,
  GOAL_STATUS_COMMAND_SPEC,
  GOAL_SET_COMMAND_SPEC,
  GOAL_CREATE_COMMAND_SPEC,
  GOAL_COMPLETE_COMMAND_SPEC,
  GOAL_VALIDATE_COMMAND_SPEC,
  GOAL_ADD_TASK_COMMAND_SPEC,
  GOALS_COMMAND_SPECS
} from './goals'
import { COMMAND_SPECS } from './index'
import { findCommandSpec, normalizeCommandPositionals } from '../args'
import { dispatch, type HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'
import { worktreeGoalsManager } from '../../main/goals/worktree-goals-manager'
import type { WorkspaceGoalsData } from '../../shared/goals/goals-schema'

describe('GOALS_COMMAND_SPEC and specs', () => {
  it('defines the goal command structure and subcommands', () => {
    expect(GOALS_COMMAND_SPEC.path).toEqual(['goal'])
    expect(GOALS_COMMAND_SPEC.summary).toBeDefined()
    expect(GOALS_COMMAND_SPEC.usage).toBeDefined()
    expect(GOALS_COMMAND_SPEC.allowedFlags).toContain('worktree')
    expect(GOALS_COMMAND_SPEC.allowedFlags).toContain('json')

    expect(GOAL_STATUS_COMMAND_SPEC.path).toEqual(['goal', 'status'])
    expect(GOAL_SET_COMMAND_SPEC.path).toEqual(['goal', 'set'])
    expect(GOAL_SET_COMMAND_SPEC.positionalArgs).toEqual(['title'])
    expect(GOAL_CREATE_COMMAND_SPEC.path).toEqual(['goal', 'create'])
    expect(GOAL_CREATE_COMMAND_SPEC.positionalArgs).toEqual(['title'])
    expect(GOAL_COMPLETE_COMMAND_SPEC.path).toEqual(['goal', 'complete'])
    expect(GOAL_COMPLETE_COMMAND_SPEC.positionalArgs).toEqual(['id-or-index'])
    expect(GOAL_COMPLETE_COMMAND_SPEC.allowedFlags).toContain('id-or-index')

    expect(GOAL_VALIDATE_COMMAND_SPEC.path).toEqual(['goal', 'validate'])
    expect(GOAL_ADD_TASK_COMMAND_SPEC.path).toEqual(['goal', 'add-task'])
    expect(GOAL_ADD_TASK_COMMAND_SPEC.positionalArgs).toEqual(['title'])
    expect(GOAL_ADD_TASK_COMMAND_SPEC.allowedFlags).toContain('title')

    expect(GOALS_COMMAND_SPECS).toContain(GOALS_COMMAND_SPEC)
    expect(GOALS_COMMAND_SPECS).toContain(GOAL_STATUS_COMMAND_SPEC)
    expect(GOALS_COMMAND_SPECS).toContain(GOAL_SET_COMMAND_SPEC)
    expect(GOALS_COMMAND_SPECS).toContain(GOAL_CREATE_COMMAND_SPEC)
    expect(GOALS_COMMAND_SPECS).toContain(GOAL_COMPLETE_COMMAND_SPEC)
    expect(GOALS_COMMAND_SPECS).toContain(GOAL_VALIDATE_COMMAND_SPEC)
    expect(GOALS_COMMAND_SPECS).toContain(GOAL_ADD_TASK_COMMAND_SPEC)
  })

  it('is included in COMMAND_SPECS and resolvable', () => {
    expect(findCommandSpec(COMMAND_SPECS, ['goal'])).toBeDefined()
    expect(findCommandSpec(COMMAND_SPECS, ['goal', 'status'])).toBeDefined()
    expect(findCommandSpec(COMMAND_SPECS, ['goal', 'set'])).toBeDefined()
    expect(findCommandSpec(COMMAND_SPECS, ['goal', 'create'])).toBeDefined()
    expect(findCommandSpec(COMMAND_SPECS, ['goal', 'complete'])).toBeDefined()
    expect(findCommandSpec(COMMAND_SPECS, ['goal', 'validate'])).toBeDefined()
    expect(findCommandSpec(COMMAND_SPECS, ['goal', 'add-task'])).toBeDefined()
  })

  it('normalizes positional arguments for complete, add-task, and set', () => {
    const completeParsed = normalizeCommandPositionals(COMMAND_SPECS, {
      commandPath: ['goal', 'complete', '1'],
      flags: new Map()
    })
    expect(completeParsed.commandPath).toEqual(['goal', 'complete'])
    expect(completeParsed.flags.get('id-or-index')).toBe('1')

    const addTaskParsed = normalizeCommandPositionals(COMMAND_SPECS, {
      commandPath: ['goal', 'add-task', 'Build new feature'],
      flags: new Map()
    })
    expect(addTaskParsed.commandPath).toEqual(['goal', 'add-task'])
    expect(addTaskParsed.flags.get('title')).toBe('Build new feature')

    const setParsed = normalizeCommandPositionals(COMMAND_SPECS, {
      commandPath: ['goal', 'set', 'Configure target'],
      flags: new Map()
    })
    expect(setParsed.commandPath).toEqual(['goal', 'set'])
    expect(setParsed.flags.get('title')).toBe('Configure target')
  })
})

describe('goals CLI dispatch', () => {
  let tempDir: string
  let consoleLogSpy: ReturnType<typeof vi.spyOn>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test dummy client for HandlerContext
  const dummyClient = {} as unknown as RuntimeClient

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-goals-cli-test-'))
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(async () => {
    consoleLogSpy.mockRestore()
    worktreeGoalsManager.disposeService(tempDir)
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  function createHandlerContext(overrides: Partial<HandlerContext> = {}): HandlerContext {
    return {
      flags: new Map([['worktree', tempDir]]),
      client: dummyClient,
      cwd: tempDir,
      json: false,
      ...overrides
    }
  }

  async function seedGoals(data: WorkspaceGoalsData): Promise<void> {
    const service = worktreeGoalsManager.getService(tempDir)
    await service.saveGoals(data)
    await service.projectCurrentGoalFile()
  }

  it('handles goal status when no goals exist', async () => {
    const ctx = createHandlerContext()
    await dispatch(['goal', 'status'], ctx)

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('No active goal found'))
  })

  it('handles goal status with active goal and human-readable formatting', async () => {
    await seedGoals({
      activeGoalId: 'g-1',
      goals: [
        {
          id: 'g-1',
          title: 'Implement Authentication',
          description: 'OAuth and JWT login flow',
          status: 'in_progress',
          subtasks: [
            { id: 't-1', title: 'Setup auth routes', completed: true },
            { id: 't-2', title: 'Write tests', completed: false }
          ],
          validation: {
            command: 'npm test',
            status: 'idle'
          },
          createdAt: 1000,
          updatedAt: 1000
        }
      ]
    })

    const ctx = createHandlerContext()
    await dispatch(['goal', 'status'], ctx)

    const output = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(output).toContain('Implement Authentication')
    expect(output).toContain('[x] 1. Setup auth routes')
    expect(output).toContain('[ ] 2. Write tests')
  })

  it('handles goal status with --json output', async () => {
    await seedGoals({
      activeGoalId: 'g-1',
      goals: [
        {
          id: 'g-1',
          title: 'JSON Test Goal',
          status: 'in_progress',
          subtasks: [{ id: 't-1', title: 'Task 1', completed: false }],
          createdAt: 1000,
          updatedAt: 1000
        }
      ]
    })

    const ctx = createHandlerContext({ json: true })
    await dispatch(['goal', 'status'], ctx)

    const raw = consoleLogSpy.mock.calls[0][0]
    const parsed = JSON.parse(raw)
    expect(parsed.activeGoalId).toBe('g-1')
    expect(parsed.activeGoal.title).toBe('JSON Test Goal')
  })

  it('handles goal set and activates goal with projection', async () => {
    const ctx = createHandlerContext({
      flags: new Map([
        ['worktree', tempDir],
        ['title', 'Goal from CLI'],
        ['description', 'A test description'],
        ['validation', 'npm test']
      ])
    })
    await dispatch(['goal', 'set'], ctx)

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Active goal set: "Goal from CLI"')
    )

    const service = worktreeGoalsManager.getService(tempDir)
    const data = await service.loadGoals()
    expect(data.goals.length).toBe(1)
    expect(data.activeGoalId).toBe(data.goals[0].id)
    expect(data.goals[0].title).toBe('Goal from CLI')
    expect(data.goals[0].description).toBe('A test description')
    expect(data.goals[0].validation?.command).toBe('npm test')

    // Check CURRENT_GOAL.md projection
    const mdContent = await fs.readFile(path.join(tempDir, '.orca', 'CURRENT_GOAL.md'), 'utf8')
    expect(mdContent).toContain('Goal from CLI')
    expect(mdContent).toContain('A test description')
  })

  it('handles goal add-task and projects CURRENT_GOAL.md', async () => {
    await seedGoals({
      activeGoalId: 'g-1',
      goals: [
        {
          id: 'g-1',
          title: 'My Goal',
          status: 'in_progress',
          subtasks: [],
          createdAt: 1000,
          updatedAt: 1000
        }
      ]
    })

    const ctx = createHandlerContext({
      flags: new Map([
        ['worktree', tempDir],
        ['title', 'New Feature Task']
      ])
    })
    await dispatch(['goal', 'add-task'], ctx)

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('New Feature Task'))

    const service = worktreeGoalsManager.getService(tempDir)
    const data = await service.loadGoals()
    const activeGoal = data.goals.find((g) => g.id === 'g-1')
    expect(activeGoal?.subtasks.length).toBe(1)
    expect(activeGoal?.subtasks[0].title).toBe('New Feature Task')
    expect(activeGoal?.subtasks[0].completed).toBe(false)

    // Check CURRENT_GOAL.md projection
    const mdContent = await fs.readFile(path.join(tempDir, '.orca', 'CURRENT_GOAL.md'), 'utf8')
    expect(mdContent).toContain('New Feature Task')
  })

  it('handles goal complete by index and by ID', async () => {
    await seedGoals({
      activeGoalId: 'g-1',
      goals: [
        {
          id: 'g-1',
          title: 'My Goal',
          status: 'in_progress',
          subtasks: [
            { id: 'task-100', title: 'First Task', completed: false },
            { id: 'task-200', title: 'Second Task', completed: false }
          ],
          createdAt: 1000,
          updatedAt: 1000
        }
      ]
    })

    // Complete by 1-based index (1 -> task-100)
    const ctxIndex = createHandlerContext({
      flags: new Map([
        ['worktree', tempDir],
        ['id-or-index', '1']
      ])
    })
    await dispatch(['goal', 'complete'], ctxIndex)

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Completed subtask: "First Task"')
    )
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Remaining tasks: 1'))

    // Complete by ID (task-200)
    const ctxId = createHandlerContext({
      flags: new Map([
        ['worktree', tempDir],
        ['id-or-index', 'task-200']
      ])
    })
    await dispatch(['goal', 'complete'], ctxId)

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Completed subtask: "Second Task"')
    )
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Remaining tasks: 0'))

    const service = worktreeGoalsManager.getService(tempDir)
    const data = await service.loadGoals()
    const activeGoal = data.goals.find((g) => g.id === 'g-1')
    expect(activeGoal?.subtasks.every((t) => t.completed)).toBe(true)
  })

  it('handles goal validate and records execution result', async () => {
    await seedGoals({
      activeGoalId: 'g-1',
      goals: [
        {
          id: 'g-1',
          title: 'Validating Goal',
          status: 'in_progress',
          subtasks: [],
          validation: {
            command: process.platform === 'win32' ? 'echo pass-win' : 'echo pass-unix',
            status: 'idle'
          },
          createdAt: 1000,
          updatedAt: 1000
        }
      ]
    })

    const ctx = createHandlerContext()
    await dispatch(['goal', 'validate'], ctx)

    const output = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(output).toContain('Validation Passed')

    const service = worktreeGoalsManager.getService(tempDir)
    const data = await service.loadGoals()
    const activeGoal = data.goals.find((g) => g.id === 'g-1')
    expect(activeGoal?.validation?.status).toBe('success')
    expect(activeGoal?.validation?.exitCode).toBe(0)
  })
})
