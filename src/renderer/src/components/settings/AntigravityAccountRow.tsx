import React from 'react'
import { Loader2, Pencil, Trash2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { AntigravityAccountSummary } from '../../../../shared/antigravity-account-types'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { getQuotaBarColorClass, getQuotaTextColorClass } from '../status-bar/status-bar-quota-tones'
import { formatResetCountdown } from '../../../../shared/rate-limit-reset-format'
import { formatAccountTimestamp } from './accounts-pane-runtime'
import { AntigravityAccountGlyph } from '@/components/agent/AntigravityAccountGlyph'

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
    <div
      className={`flex flex-col justify-between gap-2.5 rounded-lg border p-3 transition-colors ${
        isActive
          ? 'border-primary/40 bg-accent/15 ring-1 ring-primary/20'
          : 'border-border/70 bg-card/40 hover:border-border hover:bg-card/70'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <AntigravityAccountGlyph account={account} size="md" />
          <div className="min-w-0 flex-1">
            <p
              className="truncate text-xs font-medium text-foreground"
              title={account.alias ?? account.email ?? ''}
            >
              {account.alias ||
                account.email ||
                translate('accounts.antigravity.saved', 'Saved Google account')}
            </p>
            {account.alias && account.email ? (
              <p className="truncate text-[10px] text-muted-foreground" title={account.email}>
                {account.email}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {isActive && (
            <Badge variant="secondary">
              {translate('accounts.antigravity.nativeActive', 'Native account')}
            </Badge>
          )}
          <Button
            size="icon-xs"
            variant="ghost"
            disabled={busy}
            onClick={onEdit}
            aria-label={translate('accounts.antigravity.edit', 'Edit')}
            title={translate('accounts.antigravity.edit', 'Edit')}
          >
            <Pencil className="size-3" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            disabled={busy || isActive || isSelected}
            onClick={onRemove}
            aria-label={translate('accounts.antigravity.remove', 'Remove')}
            title={translate('accounts.antigravity.remove', 'Remove')}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      </div>

      <div className="mt-0.5 space-y-2 border-t border-border/40 pt-2">
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
          <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            <span>{translate('accounts.antigravity.refreshingUsage', 'Updating usage…')}</span>
          </div>
        ) : accountUsage ? (
          accountUsage.error ? (
            <p className="text-xs text-destructive">{accountUsage.error}</p>
          ) : (
            <div className="space-y-2 text-xs">
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

      <div className="mt-1 flex items-center justify-end border-t border-border/40 pt-2">
        <Button
          size="xs"
          variant={isSelected && isActive ? 'secondary' : 'outline'}
          disabled={busy}
          onClick={onSelect}
          className="w-full justify-center"
        >
          {isSelected && isActive
            ? translate('accounts.antigravity.selected', 'Selected')
            : translate('accounts.antigravity.select', 'Select')}
        </Button>
      </div>
    </div>
  )
}
