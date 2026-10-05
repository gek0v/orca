import type { ProviderRateLimits } from './rate-limit-types'

export type AntigravityAccountMetadata = {
  alias?: string | null
  color?: string | null
  emoji?: string | null
}

export type AntigravityAccountSummary = {
  id: string
  email: string | null
  subject: string | null
  authMethod: string
  alias?: string | null
  color?: string | null
  emoji?: string | null
  createdAt: number
  updatedAt: number
  lastUsage?: ProviderRateLimits | null
  lastUsageAt?: number | null
}

export type AntigravityAccountState = {
  accounts: AntigravityAccountSummary[]
  activeAccountId: string | null
  currentAccount: {
    email: string | null
    subject: string | null
    authMethod: string
    identityKnown: boolean
  } | null
  selectedAccountId: string | null
}

export type AntigravityAccountTarget = {
  runtime: 'host' | 'wsl'
  wslDistro?: string | null
}
