import React from 'react'
import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { AntigravityAccountSummary } from '../../../../shared/antigravity-account-types'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { getQuotaBarColorClass, getQuotaTextColorClass } from '../status-bar/status-bar-quota-tones'
import { formatResetCountdown } from '../../../../shared/rate-limit-reset-format'
import { formatAccountTimestamp } from './accounts-pane-runtime'

export function AntigravityAccountRow({
  account,
  isActive,
  isSelected,
  accountUsage,
  isAccountRefreshing,
  lastUpdated,
  now,
  busy,
  onEdit,
  onSelect,
  onRemove
}: {
  account: AntigravityAccountSummary
  isActive: boolean
  isSelected: boolean
  accountUsage: ProviderRateLimits | null
  isAccountRefreshing: boolean
  lastUpdated: number | null
  now: number
  busy: boolean
  onEdit: () => void
  onSelect: () => void
  onRemove: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            {account.emoji ? (
              <span className="text-sm select-none leading-none" data-account-emoji={account.emoji}>
                {account.emoji}
              </span>
            ) : account.color ? (
              <span
                className="size-2 rounded-full shrink-0"
                style={{ backgroundColor: account.color }}
                data-account-color={account.color}
              />
            ) : null}
            <p className="text-xs font-medium">
              {account.alias
                ? `${account.alias} (${account.email ?? ''})`
                : (account.email ??
                  translate('accounts.antigravity.saved', 'Saved Google account'))}
            </p>
          </div>
          {isActive && (
            <Badge variant="secondary">
              {translate('accounts.antigravity.nativeActive', 'Native account')}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button size="xs" variant="outline" disabled={busy} onClick={onEdit}>
            {translate('accounts.antigravity.edit', 'Edit')}
          </Button>
          <Button size="xs" variant="outline" disabled={busy} onClick={onSelect}>
            {isSelected && isActive
              ? translate('accounts.antigravity.selected', 'Selected')
              : translate('accounts.antigravity.select', 'Select')}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy || isActive || isSelected}
            onClick={onRemove}
          >
            {translate('accounts.antigravity.remove', 'Remove')}
          </Button>
        </div>
      </div>

      <div className="mt-1 pt-2 border-t border-border/40 space-y-2">
        <div className="flex items-center justify-between text-[11px]">
          <span className="font-medium text-muted-foreground">
            {translate('accounts.antigravity.usageTitle', 'Usage')}
          </span>
          {lastUpdated ? (
            <span className="text-[10px] text-muted-foreground/80">
              {translate('accounts.antigravity.lastUpdated', 'Updated {{time}}', {
                time: formatAccountTimestamp(lastUpdated)
              })}
            </span>
          ) : null}
        </div>
        {isAccountRefreshing ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
            <Loader2 className="size-3.5 animate-spin" />
            <span>{translate('accounts.antigravity.refreshingUsage', 'Updating usage…')}</span>
          </div>
        ) : accountUsage ? (
          accountUsage.error ? (
            <p className="text-xs text-destructive">{accountUsage.error}</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              {accountUsage.session && (
                <div className="space-y-1 rounded bg-muted/30 p-2 border border-border/30">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground font-medium">
                      {translate('accounts.antigravity.session', 'Session')}
                    </span>
                    <span
                      className={`font-semibold tabular-nums ${getQuotaTextColorClass(accountUsage.session.usedPercent)}`}
                    >
                      {Math.round(accountUsage.session.usedPercent)}%
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${getQuotaBarColorClass(accountUsage.session.usedPercent)}`}
                      style={{
                        width: `${Math.min(100, Math.max(0, accountUsage.session.usedPercent))}%`
                      }}
                    />
                  </div>
                  {accountUsage.session.resetDescription ? (
                    <p className="text-[10px] text-muted-foreground">
                      {accountUsage.session.resetDescription}
                    </p>
                  ) : accountUsage.session.resetsAt ? (
                    <p className="text-[10px] text-muted-foreground">
                      {formatResetCountdown(accountUsage.session.resetsAt - now)}
                    </p>
                  ) : null}
                </div>
              )}
              {accountUsage.weekly && (
                <div className="space-y-1 rounded bg-muted/30 p-2 border border-border/30">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground font-medium">
                      {translate('accounts.antigravity.weekly', 'Weekly')}
                    </span>
                    <span
                      className={`font-semibold tabular-nums ${getQuotaTextColorClass(accountUsage.weekly.usedPercent)}`}
                    >
                      {Math.round(accountUsage.weekly.usedPercent)}%
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${getQuotaBarColorClass(accountUsage.weekly.usedPercent)}`}
                      style={{
                        width: `${Math.min(100, Math.max(0, accountUsage.weekly.usedPercent))}%`
                      }}
                    />
                  </div>
                  {accountUsage.weekly.resetDescription ? (
                    <p className="text-[10px] text-muted-foreground">
                      {accountUsage.weekly.resetDescription}
                    </p>
                  ) : accountUsage.weekly.resetsAt ? (
                    <p className="text-[10px] text-muted-foreground">
                      {formatResetCountdown(accountUsage.weekly.resetsAt - now)}
                    </p>
                  ) : null}
                </div>
              )}
              {accountUsage.buckets &&
                accountUsage.buckets.length > 0 &&
                !accountUsage.session &&
                !accountUsage.weekly &&
                accountUsage.buckets.map((bucket) => (
                  <div
                    key={bucket.name}
                    className="space-y-1 rounded bg-muted/30 p-2 border border-border/30"
                  >
                    <div className="flex items-center justify-between text-[11px]">
                      <span
                        className="text-muted-foreground font-medium truncate"
                        title={bucket.name}
                      >
                        {bucket.name}
                      </span>
                      <span
                        className={`font-semibold tabular-nums ${getQuotaTextColorClass(bucket.usedPercent)}`}
                      >
                        {Math.round(bucket.usedPercent)}%
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${getQuotaBarColorClass(bucket.usedPercent)}`}
                        style={{
                          width: `${Math.min(100, Math.max(0, bucket.usedPercent))}%`
                        }}
                      />
                    </div>
                  </div>
                ))}
            </div>
          )
        ) : (
          <p className="text-[11px] text-muted-foreground py-0.5">
            {translate('accounts.antigravity.noUsageData', 'No usage data yet')}
          </p>
        )}
      </div>
    </div>
  )
}
