import React from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useAntigravityAccounts } from '@/hooks/useAntigravityAccounts'
import { translate } from '@/i18n/i18n'
import type { AntigravityAccountSummary } from '../../../../shared/antigravity-account-types'

export const CURRENT_ACTIVE_ANTIGRAVITY_ACCOUNT_SENTINEL = '__current__'

export type AntigravityAccountSelectorProps = {
  value?: string | null
  onValueChange: (accountId: string | null) => void
  disabled?: boolean
  placeholder?: string
  id?: string
  'aria-label'?: string
}

const DEFAULT_ACCOUNT_COLOR = '#3b82f6'

export function AntigravityAccountBadgeIcon({
  account,
  defaultColor = DEFAULT_ACCOUNT_COLOR
}: {
  account?: AntigravityAccountSummary | null
  defaultColor?: string
}): React.JSX.Element {
  if (account?.emoji) {
    return (
      <span
        className="text-[12px] leading-none select-none shrink-0"
        data-account-emoji={account.emoji}
      >
        {account.emoji}
      </span>
    )
  }
  const color = account?.color?.trim() || defaultColor
  return (
    <span
      className="size-2 rounded-full shrink-0"
      style={{ backgroundColor: color }}
      data-account-color={color}
    />
  )
}

function getActiveAccountDetail(activeAccount: AntigravityAccountSummary | null): string {
  if (!activeAccount) {
    return ''
  }
  const alias = activeAccount.alias?.trim()
  const identifier = activeAccount.email?.trim() || activeAccount.subject?.trim()
  if (alias && identifier) {
    return ` (${alias} · ${identifier})`
  }
  if (alias) {
    return ` (${alias})`
  }
  if (identifier) {
    return ` (${identifier})`
  }
  return ''
}

function getSavedAccountLabel(acc: AntigravityAccountSummary): string {
  const alias = acc.alias?.trim()
  const identifier = acc.email?.trim() || acc.subject?.trim()
  if (alias) {
    return identifier ? `${alias} (${identifier})` : alias
  }
  return identifier || translate('accounts.antigravity.saved', 'Saved Google account')
}

export function AntigravityAccountSelector({
  value,
  onValueChange,
  disabled,
  placeholder,
  id,
  'aria-label': ariaLabel
}: AntigravityAccountSelectorProps): React.JSX.Element {
  const { accounts, activeAccount } = useAntigravityAccounts()

  const currentValue =
    !value || value === CURRENT_ACTIVE_ANTIGRAVITY_ACCOUNT_SENTINEL
      ? CURRENT_ACTIVE_ANTIGRAVITY_ACCOUNT_SENTINEL
      : value

  const activeAccountDetail = getActiveAccountDetail(activeAccount)

  const isKnownAccount =
    currentValue === CURRENT_ACTIVE_ANTIGRAVITY_ACCOUNT_SENTINEL ||
    accounts.some((acc) => acc.id === currentValue)

  return (
    <Select
      value={currentValue}
      disabled={disabled}
      onValueChange={(val) =>
        onValueChange(val === CURRENT_ACTIVE_ANTIGRAVITY_ACCOUNT_SENTINEL ? null : val)
      }
    >
      <SelectTrigger
        id={id}
        aria-label={ariaLabel ?? translate('accounts.antigravity.account', 'Account')}
        data-testid="antigravity-account-selector-trigger"
        className="h-9 w-full min-w-0"
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={CURRENT_ACTIVE_ANTIGRAVITY_ACCOUNT_SENTINEL}>
          <span className="flex items-center gap-2 truncate">
            <AntigravityAccountBadgeIcon account={activeAccount} />
            <span className="truncate">
              {translate('accounts.antigravity.currentActive', 'Current active account')}
              {activeAccountDetail}
            </span>
          </span>
        </SelectItem>
        {accounts.length > 0 ? <SelectSeparator /> : null}
        {accounts.map((acc) => {
          const displayLabel = getSavedAccountLabel(acc)
          return (
            <SelectItem key={acc.id} value={acc.id}>
              <span className="flex items-center gap-2 truncate">
                <AntigravityAccountBadgeIcon account={acc} />
                <span className="truncate">{displayLabel}</span>
              </span>
            </SelectItem>
          )
        })}
        {!isKnownAccount ? (
          <SelectItem value={currentValue}>
            <span className="flex items-center gap-2 truncate">
              <span
                className="size-2 rounded-full shrink-0"
                style={{ backgroundColor: '#64748b' }}
                data-account-color="#64748b"
              />
              <span className="truncate">{currentValue}</span>
            </span>
          </SelectItem>
        ) : null}
      </SelectContent>
    </Select>
  )
}
