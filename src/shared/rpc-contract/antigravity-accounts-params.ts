import { z } from 'zod'

export const AntigravityAccountTargetParams = z
  .object({
    runtime: z.enum(['host', 'wsl']),
    wslDistro: z.string().min(1).max(255).nullable().optional()
  })
  .strict()

export const AntigravityAccountMutationParams = z
  .object({
    target: AntigravityAccountTargetParams,
    accountId: z.string().min(1).max(128)
  })
  .strict()

export const AntigravityAccountUpdateParams = z
  .object({
    target: AntigravityAccountTargetParams,
    accountId: z.string().min(1).max(128),
    alias: z.string().max(128).nullable().optional(),
    color: z.string().max(32).nullable().optional(),
    emoji: z.string().max(16).nullable().optional()
  })
  .strict()
