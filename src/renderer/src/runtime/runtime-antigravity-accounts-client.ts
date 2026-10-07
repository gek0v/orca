import type {
  AntigravityAccountState,
  AntigravityAccountTarget
} from '../../../shared/antigravity-account-types'
import { ANTIGRAVITY_ACCOUNTS_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { RuntimeClientTarget } from './runtime-client-target'
import { assertRuntimeEnvironmentCapability, callRuntimeRpc } from './runtime-rpc-client'

export type AntigravityAccountUpdateOptions = {
  accountId: string
  alias?: string | null
  color?: string | null
  emoji?: string | null
}

export async function callAntigravityAccounts(
  owner: RuntimeClientTarget,
  target: AntigravityAccountTarget,
  action: 'List' | 'AddCurrent' | 'Select' | 'Remove' | 'Update',
  payload?: string | AntigravityAccountUpdateOptions
): Promise<AntigravityAccountState> {
  if (owner.kind === 'environment') {
    await assertRuntimeEnvironmentCapability(
      owner.environmentId,
      ANTIGRAVITY_ACCOUNTS_RUNTIME_CAPABILITY,
      'This execution host does not support native Antigravity Accounts yet. Update Orca on that host.'
    )
  }
  const params =
    action === 'List' || action === 'AddCurrent'
      ? target
      : typeof payload === 'string'
        ? { target, accountId: payload }
        : { target, ...payload }
  return callRuntimeRpc(owner, `accounts.antigravity${action}`, params, { timeoutMs: 20_000 })
}
