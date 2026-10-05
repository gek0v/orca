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
import { AUTOMATION_EDITOR_SECTION_LABEL_CLASS, Field } from './automation-page-parts'
import type { AutomationDraft } from './AutomationEditorDialog'

type AutomationAntigravityAccountFieldProps = {
  draft: AutomationDraft
  disabled?: boolean
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}

export const CURRENT_ACTIVE_ANTIGRAVITY_ACCOUNT_SENTINEL = '__current__'

export function AutomationAntigravityAccountField({
  draft,
  disabled,
  onDraftChange
}: AutomationAntigravityAccountFieldProps): React.JSX.Element {
  const { accounts, activeAccount } = useAntigravityAccounts()

  const currentValue = draft.launchAccountId ?? CURRENT_ACTIVE_ANTIGRAVITY_ACCOUNT_SENTINEL
  const activeDotColor = activeAccount?.color?.trim() || '#3b82f6'

  return (
    <Field
      labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS}
      label={translate('accounts.antigravity.account', 'Account')}
    >
      <Select
        value={currentValue}
        disabled={disabled}
        onValueChange={(val) =>
          onDraftChange((current) => ({
            ...current,
            launchAccountId: val === CURRENT_ACTIVE_ANTIGRAVITY_ACCOUNT_SENTINEL ? null : val
          }))
        }
      >
        <SelectTrigger className="h-9 w-full min-w-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={CURRENT_ACTIVE_ANTIGRAVITY_ACCOUNT_SENTINEL}>
            <span className="flex items-center gap-2 truncate">
              <span
                className="size-2 rounded-full shrink-0"
                style={{ backgroundColor: activeDotColor }}
              />
              <span className="truncate">
                {translate('accounts.antigravity.currentActive', 'Current active account')}
                {activeAccount?.email ? ` (${activeAccount.email})` : ''}
              </span>
            </span>
          </SelectItem>
          {accounts.length > 0 ? <SelectSeparator /> : null}
          {accounts.map((acc) => {
            const dotColor = acc.color?.trim() || '#3b82f6'
            const displayLabel = acc.alias?.trim()
              ? `${acc.alias.trim()} (${acc.email ?? acc.subject ?? ''})`
              : (acc.email ??
                acc.subject ??
                translate('accounts.antigravity.saved', 'Saved Google account'))

            return (
              <SelectItem key={acc.id} value={acc.id}>
                <span className="flex items-center gap-2 truncate">
                  <span
                    className="size-2 rounded-full shrink-0"
                    style={{ backgroundColor: dotColor }}
                  />
                  <span className="truncate">{displayLabel}</span>
                </span>
              </SelectItem>
            )
          })}
        </SelectContent>
      </Select>
    </Field>
  )
}
