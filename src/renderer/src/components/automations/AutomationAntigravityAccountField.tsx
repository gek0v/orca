import React from 'react'
import {
  AntigravityAccountSelector,
  CURRENT_ACTIVE_ANTIGRAVITY_ACCOUNT_SENTINEL
} from '@/components/agent/AntigravityAccountSelector'
import { translate } from '@/i18n/i18n'
import { AUTOMATION_EDITOR_SECTION_LABEL_CLASS, Field } from './automation-page-parts'
import type { AutomationDraft } from './AutomationEditorDialog'

export { CURRENT_ACTIVE_ANTIGRAVITY_ACCOUNT_SENTINEL }

type AutomationAntigravityAccountFieldProps = {
  draft: AutomationDraft
  disabled?: boolean
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}

export function AutomationAntigravityAccountField({
  draft,
  disabled,
  onDraftChange
}: AutomationAntigravityAccountFieldProps): React.JSX.Element {
  return (
    <Field
      labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS}
      label={translate('accounts.antigravity.account', 'Account')}
    >
      <AntigravityAccountSelector
        value={draft.launchAccountId}
        disabled={disabled}
        onValueChange={(launchAccountId) =>
          onDraftChange((current) => ({
            ...current,
            launchAccountId
          }))
        }
      />
    </Field>
  )
}
