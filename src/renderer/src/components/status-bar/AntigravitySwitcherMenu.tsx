import { ChevronDown, ChevronRight } from 'lucide-react'
import React, { useMemo, useState } from 'react'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '../../store'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import {
  setCachedAntigravityAccountsState,
  updateCachedAccountUsage,
  useAntigravityAccounts
} from '@/hooks/useAntigravityAccounts'
import { callAntigravityAccounts } from '@/runtime/runtime-antigravity-accounts-client'
import { translate } from '@/i18n/i18n'
import { useWindowsTerminalCapabilities } from '@/lib/windows-terminal-capabilities'
import {
  getCodexStatusRuntimeKey,
  getStatusBarPreferredWslDistro,
  shouldIncludeSettingsWslRuntime,
  type CodexStatusRuntimeTarget,
  type CodexStatusSwitchGroup
} from './status-bar-runtime-targets'
import { AccountRuntimeToggle } from './StatusBarAccountControls'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { InlineUsageBars } from './InlineProviderUsage'
import { ProviderDetailsMenu } from './ProviderDetailsMenu'

export function AntigravitySwitcherMenu({
  antigravity,
  compact,
  iconOnly,
  asSubmenu = false,
  triggerContent
}: {
  antigravity: ProviderRateLimits
  compact: boolean
  iconOnly: boolean
  asSubmenu?: boolean
  triggerContent?: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [accountsExpanded, setAccountsExpanded] = useState(false)
  const [isSwitching, setIsSwitching] = useState(false)
  const [selectedRuntimeTarget, setSelectedRuntimeTarget] = useState<CodexStatusRuntimeTarget>({
    runtime: 'host',
    wslDistro: null
  })

  const { accounts, activeAccount } = useAntigravityAccounts()
  const settings = useAppStore((s) => s.settings)
  const windowsTerminalCapabilities = useWindowsTerminalCapabilities(
    navigator.userAgent.includes('Windows'),
    false
  )
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const refreshRateLimits = useAppStore((s) => s.refreshRateLimits)
  const setAntigravityRateLimitsOptimistic = useAppStore(
    (s) => s.setAntigravityRateLimitsOptimistic
  )
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const repos = useAppStore((s) => s.repos)

  const switchGroups = useMemo<CodexStatusSwitchGroup[]>(() => {
    const hostLabel = navigator.userAgent.includes('Windows') ? 'Windows' : 'This device'
    const fallbackWslDistro = getStatusBarPreferredWslDistro(
      settings,
      windowsTerminalCapabilities.wslDistros
    )
    const distros = windowsTerminalCapabilities.wslDistros
    const groups: CodexStatusSwitchGroup[] = [
      {
        key: 'host',
        label: hostLabel,
        runtimeTarget: { runtime: 'host', wslDistro: null },
        targets: []
      }
    ]
    if (distros.length > 0) {
      for (const distro of distros) {
        groups.push({
          key: `wsl:${distro}`,
          label: `WSL ${distro}`,
          runtimeTarget: { runtime: 'wsl', wslDistro: distro },
          targets: []
        })
      }
    } else if (shouldIncludeSettingsWslRuntime(settings) && fallbackWslDistro) {
      groups.push({
        key: `wsl:${fallbackWslDistro}`,
        label: `WSL ${fallbackWslDistro}`,
        runtimeTarget: { runtime: 'wsl', wslDistro: fallbackWslDistro },
        targets: []
      })
    }
    return groups
  }, [settings, windowsTerminalCapabilities.wslDistros])

  const selectedRuntimeKey = getCodexStatusRuntimeKey(selectedRuntimeTarget)
  const selectedGroup = switchGroups.find((g) => g.key === selectedRuntimeKey) ?? switchGroups[0]

  const handleSelectRuntime = (group: CodexStatusSwitchGroup): void => {
    setSelectedRuntimeTarget(group.runtimeTarget)
    setAccountsExpanded(false)
  }

  const handleSelectAccount = async (accountId: string): Promise<void> => {
    if (isSwitching || accountId === activeAccount?.id) {
      return
    }
    try {
      setIsSwitching(true)
      const targetAccount = accounts.find((a) => a.id === accountId)
      if (activeAccount && antigravity?.status === 'ok') {
        updateCachedAccountUsage(activeAccount.id, antigravity)
      }
      setAntigravityRateLimitsOptimistic?.(targetAccount?.lastUsage ?? null)
      const target =
        selectedGroup.runtimeTarget.runtime === 'host'
          ? { runtime: 'host' as const }
          : {
              runtime: 'wsl' as const,
              wslDistro: selectedGroup.runtimeTarget.wslDistro ?? undefined
            }
      const res = await callAntigravityAccounts({ kind: 'local' }, target, 'Select', accountId)
      setCachedAntigravityAccountsState(res)
      if (refreshRateLimits) {
        void refreshRateLimits()
      }
    } catch (error) {
      console.error('Failed to switch Antigravity account:', error)
    } finally {
      setIsSwitching(false)
    }
  }

  const activeLabel =
    activeAccount?.alias ||
    activeAccount?.email ||
    translate('auto.components.status.bar.StatusBar.c676918adc', 'System default')
  const projectDefaultAccountId = useMemo(() => {
    const repoId = activeWorktreeId ? getRepoIdFromWorktreeId(activeWorktreeId) : activeRepoId
    const activeRepo = repos?.find((r) => r.id === repoId)
    return activeRepo?.antigravityAccountId ?? null
  }, [activeWorktreeId, activeRepoId, repos])

  const projectDefaultAccount = useMemo(() => {
    if (!projectDefaultAccountId) {
      return null
    }
    return accounts.find((a) => a.id === projectDefaultAccountId) ?? null
  }, [accounts, projectDefaultAccountId])

  const projectDefaultLabel =
    projectDefaultAccount?.alias || projectDefaultAccount?.email || projectDefaultAccountId || ''

  const alias = activeAccount?.alias?.trim() || activeAccount?.email?.split('@')[0] || null
  const title = alias ? `Antigravity (${alias})` : 'Antigravity'

  return (
    <ProviderDetailsMenu
      provider={antigravity}
      title={title}
      compact={compact}
      iconOnly={iconOnly}
      asSubmenu={asSubmenu}
      triggerContent={triggerContent}
      ariaLabel={translate(
        'auto.components.status.bar.StatusBar.antigravityOpenDetails',
        'Open Antigravity details and account switcher'
      )}
      topContent={
        <AccountRuntimeToggle
          groups={switchGroups}
          value={selectedGroup?.key ?? selectedRuntimeKey}
          onChange={handleSelectRuntime}
          ariaLabel={translate(
            'auto.components.status.bar.StatusBar.antigravityUsageRuntime',
            'Antigravity usage runtime'
          )}
        />
      }
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) {
          setAccountsExpanded(false)
        }
      }}
    >
      <DropdownMenuLabel>
        {translate(
          'auto.components.status.bar.StatusBar.antigravityAccountTitle',
          'Antigravity Account'
        )}
      </DropdownMenuLabel>
      {projectDefaultAccountId && activeAccount?.id !== projectDefaultAccountId ? (
        <div className="mx-1 mb-1 rounded-md border border-border/60 bg-muted/20 p-2">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                {translate(
                  'auto.components.status.bar.StatusBar.antigravityProjectDefaultTitle',
                  'Project Default'
                )}
              </div>
              <div className="flex items-center gap-1.5 truncate text-[11px] font-medium text-foreground">
                {projectDefaultAccount?.emoji ? (
                  <span className="shrink-0 text-xs">{projectDefaultAccount.emoji}</span>
                ) : projectDefaultAccount?.color ? (
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: projectDefaultAccount.color }}
                  />
                ) : null}
                <span className="truncate">{projectDefaultLabel}</span>
              </div>
            </div>
            <button
              type="button"
              disabled={isSwitching}
              onClick={(e) => {
                e.preventDefault()
                void handleSelectAccount(projectDefaultAccountId)
              }}
              className="inline-flex shrink-0 items-center justify-center rounded bg-accent/60 px-2 py-1 text-[10px] font-medium text-accent-foreground transition-colors hover:bg-accent"
            >
              {translate(
                'auto.components.status.bar.StatusBar.antigravitySwitchToProjectDefault',
                'Switch'
              )}
            </button>
          </div>
        </div>
      ) : null}
      <DropdownMenuItem
        onSelect={(event) => {
          event.preventDefault()
          setAccountsExpanded(!accountsExpanded)
        }}
      >
        <span className="flex min-w-0 max-w-[180px] items-center gap-1.5 truncate text-[12px] text-foreground">
          {activeAccount?.emoji ? (
            <span className="shrink-0 text-xs">{activeAccount.emoji}</span>
          ) : activeAccount?.color ? (
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: activeAccount.color }}
            />
          ) : null}
          <span className="truncate">{activeLabel}</span>
        </span>
        {accountsExpanded ? (
          <ChevronDown className="ml-auto size-3.5 text-muted-foreground/85" />
        ) : (
          <ChevronRight className="ml-auto size-3.5 text-muted-foreground/85" />
        )}
      </DropdownMenuItem>

      {accountsExpanded ? (
        <div className="px-1 pb-1">
          <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            {translate('auto.components.status.bar.StatusBar.9332ba8684', 'Switch to')}
          </div>
          <div className="max-h-[220px] overflow-y-auto rounded-md border border-border/60 bg-accent/5 p-1 scrollbar-sleek">
            {accounts.length === 0 ? (
              <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                {translate('auto.components.status.bar.StatusBar.c98ea88392', 'No other accounts')}
              </div>
            ) : null}
            {accounts.map((account) => {
              const isCurrentAccount = account.id === activeAccount?.id
              const label = account.alias || account.email || account.id
              const isFreshForThisAccount =
                isCurrentAccount &&
                !isSwitching &&
                (!antigravity.usageMetadata?.authProvenance ||
                  antigravity.usageMetadata.authProvenance === account.id) &&
                antigravity.status === 'ok'
              const usage = isFreshForThisAccount ? antigravity : account.lastUsage
              const isAccountFetching =
                isCurrentAccount && (isSwitching || antigravity.status === 'fetching')

              return (
                <DropdownMenuItem
                  key={account.id}
                  disabled={isSwitching || isCurrentAccount}
                  onSelect={(event) => {
                    event.preventDefault()
                    if (!isCurrentAccount) {
                      void handleSelectAccount(account.id)
                    }
                  }}
                >
                  <div className="flex w-full flex-col gap-0.5">
                    <div className="flex min-w-0 items-center gap-1.5">
                      {account.emoji ? (
                        <span className="shrink-0 text-xs">{account.emoji}</span>
                      ) : account.color ? (
                        <span
                          className="size-2 shrink-0 rounded-full"
                          style={{ backgroundColor: account.color }}
                        />
                      ) : null}
                      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
                      {isCurrentAccount ? (
                        <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
                          {translate('auto.components.status.bar.StatusBar.ff0fbe9311', 'Active')}
                        </span>
                      ) : null}
                      {!isCurrentAccount && account.id === projectDefaultAccountId ? (
                        <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] font-medium text-muted-foreground">
                          {translate(
                            'auto.components.status.bar.StatusBar.antigravityProjectDefaultBadge',
                            'Default'
                          )}
                        </span>
                      ) : null}
                    </div>
                    {usage ? (
                      <InlineUsageBars limits={usage} isFetching={isAccountFetching} />
                    ) : (
                      <span className="text-[10px] text-muted-foreground/70">
                        {translate(
                          'auto.components.status.bar.StatusBar.antigravityNoUsageData',
                          'No usage data yet'
                        )}
                      </span>
                    )}
                  </div>
                </DropdownMenuItem>
              )
            })}
          </div>
          <div className="px-2 py-1.5 text-[10px] leading-4 text-muted-foreground">
            {translate(
              'auto.components.status.bar.StatusBar.antigravityRestartNotice',
              'Restart live Antigravity terminals before continuing old conversations after switching.'
            )}
          </div>
        </div>
      ) : null}

      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={() => {
          openSettingsTarget({
            pane: 'accounts',
            repoId: null,
            sectionId: 'accounts-antigravity'
          })
          openSettingsPage()
        }}
      >
        {translate('auto.components.status.bar.StatusBar.75ded02687', 'Manage Accounts…')}
      </DropdownMenuItem>
    </ProviderDetailsMenu>
  )
}
