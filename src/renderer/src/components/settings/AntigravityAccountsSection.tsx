import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { AgentIcon } from '@/lib/agent-catalog'
import { callAntigravityAccounts } from '@/runtime/runtime-antigravity-accounts-client'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import type {
  AntigravityAccountState,
  AntigravityAccountSummary,
  AntigravityAccountTarget
} from '../../../../shared/antigravity-account-types'
import type { ProviderRateLimits, RateLimitState } from '../../../../shared/rate-limit-types'
import { Button } from '../ui/button'
import { AntigravityAccountEditDialog } from './AntigravityAccountEditDialog'
import { AntigravityAccountRow } from './AntigravityAccountRow'
import { refreshAllAntigravityAccountsUsage } from './antigravity-accounts-usage-refresh'
import { setCachedAntigravityAccountsState } from '@/hooks/useAntigravityAccounts'
import { useResetCountdownClock } from '@/hooks/useResetCountdownClock'

export function AntigravityAccountsSection({
  owner,
  target,
  label
}: {
  owner: RuntimeClientTarget
  target: AntigravityAccountTarget
  label: string
}): React.JSX.Element {
  const [state, setState] = useState<AntigravityAccountState | null>(null)
  const [usageSnapshot, setUsageSnapshot] = useState<{
    subject: string
    authMethod: string
    limits: ProviderRateLimits | null
  } | null>(null)
  const [accountUsageMap, setAccountUsageMap] = useState<Record<string, ProviderRateLimits>>({})
  const [refreshingAccountId, setRefreshingAccountId] = useState<string | null>(null)
  const current = state?.currentAccount
  const usage =
    current?.subject === usageSnapshot?.subject && current?.authMethod === usageSnapshot?.authMethod
      ? usageSnapshot?.limits
      : null
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editingAccount, setEditingAccount] = useState<AntigravityAccountSummary | null>(null)
  const pending = useRef(false)
  const mounted = useRef(true)
  const ownerKind = owner.kind
  const environmentId = owner.kind === 'environment' ? owner.environmentId : null
  const runtime = target.runtime
  const wslDistro = target.wslDistro ?? null

  const resetTimes = useMemo(() => {
    const times: (number | null | undefined)[] = []
    for (const acc of state?.accounts ?? []) {
      const accUsage =
        state?.activeAccountId === acc.id && usage
          ? usage
          : (accountUsageMap[acc.id] ?? acc.lastUsage ?? null)
      if (accUsage?.session?.resetsAt) {
        times.push(accUsage.session.resetsAt)
      }
      if (accUsage?.weekly?.resetsAt) {
        times.push(accUsage.weekly.resetsAt)
      }
    }
    return times
  }, [state?.accounts, state?.activeAccountId, usage, accountUsageMap])
  const now = useResetCountdownClock(resetTimes)

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    const currentOwner: RuntimeClientTarget =
      ownerKind === 'environment' && environmentId
        ? { kind: 'environment', environmentId }
        : { kind: 'local' }
    void callAntigravityAccounts(currentOwner, { runtime, wslDistro }, 'List').then(
      (next) => {
        if (!cancelled) {
          setState(next)
        }
      },
      (cause: unknown) => {
        if (!cancelled) {
          setError(
            cause instanceof Error ? cause.message : 'Antigravity accounts could not be loaded.'
          )
        }
      }
    )
    return () => {
      cancelled = true
      mounted.current = false
    }
  }, [ownerKind, environmentId, runtime, wslDistro])

  async function run(
    action: 'List' | 'AddCurrent' | 'Select' | 'Remove' | 'Usage' | 'UsageAll',
    accountId?: string
  ) {
    if (pending.current) {
      return
    }
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      if (action === 'Usage') {
        setUsageSnapshot(null)
        const before = await callAntigravityAccounts(owner, target, 'List')
        const snapshot = await callRuntimeRpc<{ rateLimits: RateLimitState }>(
          owner,
          'accounts.list',
          { refreshUsage: true }
        )
        const after = await callAntigravityAccounts(owner, target, 'List')
        if (mounted.current) {
          setState(after)
          setCachedAntigravityAccountsState(after)
        }
        if (
          !before.currentAccount?.subject ||
          before.currentAccount.subject !== after.currentAccount?.subject ||
          before.currentAccount.authMethod !== after.currentAccount.authMethod
        ) {
          throw new Error('The native account changed while reading usage. Refresh usage again.')
        }
        if (mounted.current) {
          const limits = snapshot.rateLimits.antigravity
          setUsageSnapshot({
            subject: before.currentAccount.subject,
            authMethod: before.currentAccount.authMethod,
            limits
          })
          if (before.activeAccountId && limits) {
            setAccountUsageMap((prev) => ({
              ...prev,
              [before.activeAccountId!]: limits
            }))
          }
        }
      } else if (action === 'UsageAll') {
        const after = await refreshAllAntigravityAccountsUsage({
          owner,
          target,
          isMounted: () => mounted.current,
          onRefreshingAccountId: (id) => setRefreshingAccountId(id),
          onStateUpdate: (nextState) => {
            setState(nextState)
            setCachedAntigravityAccountsState(nextState)
          },
          onAccountUsageUpdate: (accId, limits) => {
            setAccountUsageMap((prev) => ({ ...prev, [accId]: limits }))
          }
        })
        if (after && mounted.current) {
          setState(after)
          setCachedAntigravityAccountsState(after)
        }
      } else {
        if (action === 'Select') {
          setUsageSnapshot(null)
        }
        const next = await callAntigravityAccounts(owner, target, action, accountId)
        if (mounted.current) {
          setState(next)
          setCachedAntigravityAccountsState(next)
        }
      }
    } catch (cause) {
      if (action === 'Select' || action === 'Remove' || action === 'AddCurrent') {
        try {
          const observed = await callAntigravityAccounts(owner, target, 'List')
          if (mounted.current) {
            setState(observed)
          }
        } catch {
          if (mounted.current) {
            setState(null)
          }
        }
      }
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : 'Antigravity account action failed.')
      }
    } finally {
      pending.current = false
      if (mounted.current) {
        setRefreshingAccountId(null)
        setBusy(false)
      }
    }
  }

  async function handleUpdateMetadata(
    accountId: string,
    metadata: { alias?: string | null; color?: string | null }
  ) {
    setError(null)
    try {
      const next = await callAntigravityAccounts(owner, target, 'Update', {
        accountId,
        alias: metadata.alias,
        color: metadata.color
      })
      if (mounted.current) {
        setState(next)
      }
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : 'Could not update account metadata.')
      }
    }
  }

  return (
    <section id="accounts-antigravity" className="space-y-4 scroll-mt-6">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <AgentIcon agent="antigravity" size={16} />
          {translate('accounts.antigravity.title', 'Antigravity')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate('accounts.antigravity.scope', 'Manage the native agy account on {{host}}.', {
            host: label
          })}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        {translate(
          'accounts.antigravity.signIn',
          'Start agy on this host and complete its browser sign-in, then save the current account. To add a different account, use /logout in agy and sign in again.'
        )}{' '}
        <a
          className="underline"
          href="https://antigravity.google/docs/cli/install/"
          target="_blank"
          rel="noopener noreferrer"
        >
          {translate('accounts.antigravity.docs', 'Sign-in instructions')}
        </a>
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {!state && error && (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void run('List')}>
          {translate('accounts.antigravity.retry', 'Retry')}
        </Button>
      )}
      {state && (
        <div className="space-y-3">
          <p className="text-xs">
            {state.currentAccount
              ? (state.currentAccount.email ??
                translate('accounts.antigravity.identityUnknown', 'Signed-in identity unavailable'))
              : translate('accounts.antigravity.signedOut', 'No native agy account is signed in.')}
          </p>
          {state.selectedAccountId && state.activeAccountId !== state.selectedAccountId && (
            <p className="text-xs text-destructive">
              {translate(
                'accounts.antigravity.changed',
                'The native account changed. Select a saved account again before launching agy.'
              )}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={busy || !state.currentAccount?.identityKnown}
              onClick={() => void run('AddCurrent')}
            >
              {translate('accounts.antigravity.save', 'Save current account')}
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void run('List')}>
              {translate('accounts.antigravity.refresh', 'Refresh accounts')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || !state.currentAccount || target.runtime === 'wsl'}
              onClick={() => void run('Usage')}
            >
              {translate('accounts.antigravity.usage', 'Refresh usage')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || state.accounts.length === 0 || target.runtime === 'wsl'}
              onClick={() => void run('UsageAll')}
            >
              {translate('accounts.antigravity.usageAll', 'Refresh all accounts usage')}
            </Button>
            {busy && (
              <Loader2
                className="size-4 animate-spin"
                aria-label={translate('accounts.antigravity.working', 'Updating account')}
              />
            )}
          </div>
          {usage && (
            <p className="text-xs text-muted-foreground">
              {usage.error ??
                translate(
                  'accounts.antigravity.usageReading',
                  'Session: {{session}} · Weekly: {{weekly}}',
                  {
                    session: usage.session ? `${Math.round(usage.session.usedPercent)}%` : '—',
                    weekly: usage.weekly ? `${Math.round(usage.weekly.usedPercent)}%` : '—'
                  }
                )}
            </p>
          )}
          {state.accounts.map((account) => {
            const accountUsage =
              state.activeAccountId === account.id && usage
                ? usage
                : (accountUsageMap[account.id] ?? account.lastUsage ?? null)
            const isAccountRefreshing = refreshingAccountId === account.id
            const lastUpdated = accountUsage?.updatedAt ?? account.lastUsageAt ?? null

            return (
              <AntigravityAccountRow
                key={account.id}
                account={account}
                isActive={state.activeAccountId === account.id}
                isSelected={state.selectedAccountId === account.id}
                accountUsage={accountUsage}
                isAccountRefreshing={isAccountRefreshing}
                lastUpdated={lastUpdated}
                now={now}
                busy={busy}
                onEdit={() => setEditingAccount(account)}
                onSelect={() => void run('Select', account.id)}
                onRemove={() => void run('Remove', account.id)}
              />
            )
          })}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {translate(
          'accounts.antigravity.sessions',
          'Selection applies to new agy sessions on this host. Existing sessions may keep their previous account.'
        )}
      </p>
      <AntigravityAccountEditDialog
        account={editingAccount}
        open={editingAccount !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditingAccount(null)
          }
        }}
        onSave={handleUpdateMetadata}
      />
    </section>
  )
}
