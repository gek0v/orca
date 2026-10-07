import { describe, it, expect } from 'vitest'
import {
  GoalStatusSchema,
  GoalSubtaskSchema,
  GoalValidationSchema,
  GoalSchema,
  WorkspaceGoalsDataSchema
} from './goals-schema'

describe('goals-schema', () => {
  describe('GoalStatusSchema', () => {
    it('accepts all valid goal statuses', () => {
      const validStatuses = [
        'pending',
        'in_progress',
        'in_verification',
        'completed',
        'failed'
      ] as const

      for (const status of validStatuses) {
        expect(GoalStatusSchema.parse(status)).toBe(status)
      }
    })

    it('rejects invalid goal status', () => {
      expect(() => GoalStatusSchema.parse('invalid_status')).toThrow()
      expect(() => GoalStatusSchema.parse(123)).toThrow()
      expect(() => GoalStatusSchema.parse(null)).toThrow()
    })
  })

  describe('GoalSubtaskSchema', () => {
    it('validates a valid subtask', () => {
      const validSubtask = {
        id: 'sub-1',
        title: 'Run lint checks',
        completed: true
      }
      const parsed = GoalSubtaskSchema.parse(validSubtask)
      expect(parsed).toEqual(validSubtask)
    })

    it('rejects empty title and missing fields', () => {
      expect(() => GoalSubtaskSchema.parse({ id: 'sub-1', title: '', completed: false })).toThrow()
      expect(() => GoalSubtaskSchema.parse({ id: 'sub-1', completed: false })).toThrow()
      expect(() => GoalSubtaskSchema.parse({ title: 'Task', completed: false })).toThrow()
      expect(() => GoalSubtaskSchema.parse({ id: 'sub-1', title: 'Task' })).toThrow()
    })
  })

  describe('GoalValidationSchema', () => {
    it('validates a valid validation configuration with optional fields', () => {
      const validMinimal = {
        command: 'pnpm test',
        status: 'idle'
      }
      expect(GoalValidationSchema.parse(validMinimal)).toEqual(validMinimal)

      const validComplete = {
        command: 'pnpm test',
        status: 'failed',
        lastRunAt: 1700000000,
        exitCode: 1,
        summaryTail: 'Error: test failed at line 12'
      }
      expect(GoalValidationSchema.parse(validComplete)).toEqual(validComplete)
    })

    it('rejects invalid validation status and empty command', () => {
      expect(() => GoalValidationSchema.parse({ command: '', status: 'idle' })).toThrow()
      expect(() =>
        GoalValidationSchema.parse({
          command: 'pnpm test',
          status: 'unknown_status'
        })
      ).toThrow()
    })
  })

  describe('GoalSchema', () => {
    it('validates a valid complete goal', () => {
      const validGoal = {
        id: 'goal-1',
        title: 'Implement Core Feature',
        description: 'Step-by-step implementation',
        status: 'in_progress',
        subtasks: [
          { id: 'task-1', title: 'Scaffold schema', completed: true },
          { id: 'task-2', title: 'Write tests', completed: false }
        ],
        validation: {
          command: 'pnpm test',
          status: 'idle',
          summaryTail: undefined
        },
        createdAt: 1000,
        updatedAt: 2000
      }
      const parsed = GoalSchema.parse(validGoal)
      expect(parsed.id).toBe('goal-1')
      expect(parsed.subtasks).toHaveLength(2)
      expect(parsed.status).toBe('in_progress')
    })

    it('rejects empty title or missing timestamps', () => {
      const invalid = {
        id: 'g-1',
        title: '',
        status: 'pending',
        subtasks: [],
        createdAt: 1,
        updatedAt: 2
      }
      expect(() => GoalSchema.parse(invalid)).toThrow()

      const missingTimestamps = {
        id: 'g-1',
        title: 'Valid title',
        status: 'pending',
        subtasks: []
      }
      expect(() => GoalSchema.parse(missingTimestamps)).toThrow()
    })

    it('rejects invalid goal status in goal', () => {
      const invalid = {
        id: 'g-1',
        title: 'Invalid',
        status: 'unknown_status',
        subtasks: [],
        createdAt: 1,
        updatedAt: 2
      }
      expect(() => GoalSchema.parse(invalid)).toThrow()
    })
  })

  describe('WorkspaceGoalsDataSchema', () => {
    it('validates workspace goals data with activeGoalId as string or null', () => {
      const rawWithActive = {
        activeGoalId: 'goal-1',
        goals: [
          {
            id: 'goal-1',
            title: 'Implement Core Feature',
            status: 'in_progress',
            subtasks: [],
            createdAt: 1000,
            updatedAt: 2000
          }
        ]
      }
      const parsed = WorkspaceGoalsDataSchema.parse(rawWithActive)
      expect(parsed.activeGoalId).toBe('goal-1')
      expect(parsed.goals).toHaveLength(1)

      const rawWithNullActive = {
        activeGoalId: null,
        goals: []
      }
      const parsedNull = WorkspaceGoalsDataSchema.parse(rawWithNullActive)
      expect(parsedNull.activeGoalId).toBeNull()
      expect(parsedNull.goals).toHaveLength(0)
    })

    it('rejects invalid activeGoalId type or missing goals', () => {
      expect(() =>
        WorkspaceGoalsDataSchema.parse({
          activeGoalId: 123,
          goals: []
        })
      ).toThrow()

      expect(() =>
        WorkspaceGoalsDataSchema.parse({
          activeGoalId: null
        })
      ).toThrow()
    })
  })
})
