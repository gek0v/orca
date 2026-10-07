import { z } from 'zod'

export const GoalStatusSchema = z.enum([
  'pending',
  'in_progress',
  'in_verification',
  'completed',
  'failed'
])
export type GoalStatus = z.infer<typeof GoalStatusSchema>

export const GoalSubtaskWorkerStatusSchema = z.enum([
  'idle',
  'starting',
  'running',
  'completed',
  'failed'
])
export type GoalSubtaskWorkerStatus = z.infer<typeof GoalSubtaskWorkerStatusSchema>

export const GoalSubtaskWorkerSchema = z.object({
  workerId: z.string(),
  agent: z.string(),
  dispatchId: z.string().optional(),
  status: GoalSubtaskWorkerStatusSchema,
  assignedAt: z.number().optional()
})
export type GoalSubtaskWorker = z.infer<typeof GoalSubtaskWorkerSchema>

export const GoalSubtaskSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  completed: z.boolean(),
  worker: GoalSubtaskWorkerSchema.optional()
})
export type GoalSubtask = z.infer<typeof GoalSubtaskSchema>

export const GoalValidationSchema = z.object({
  command: z.string().min(1),
  status: z.enum(['idle', 'running', 'success', 'failed']),
  lastRunAt: z.number().optional(),
  exitCode: z.number().optional(),
  summaryTail: z.string().optional()
})
export type GoalValidation = z.infer<typeof GoalValidationSchema>

export const GoalSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  status: GoalStatusSchema,
  subtasks: z.array(GoalSubtaskSchema),
  validation: GoalValidationSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type Goal = z.infer<typeof GoalSchema>

export const WorkspaceGoalsDataSchema = z.object({
  activeGoalId: z.string().nullable(),
  goals: z.array(GoalSchema)
})
export type WorkspaceGoalsData = z.infer<typeof WorkspaceGoalsDataSchema>
