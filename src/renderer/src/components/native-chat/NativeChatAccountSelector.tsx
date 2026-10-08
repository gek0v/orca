import React, { useRef } from 'react'
import { Check, ChevronDown, Plus, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  useActiveWindowAntigravityAccount,
  useAntigravityAccounts,
  refreshAntigravityAccounts
} from '@/hooks/useAntigravityAccounts'
import { AntigravityAccountBadgeIcon } from '@/components/agent/AntigravityAccountSelector'
import { callAntigravityAccounts } from '@/runtime/runtime-antigravity-accounts-client'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { AntigravityAccountSummary } from '../../../../shared/antigravity-account-types'
import type { NativeChatSupportedAgent } from '@/lib/native-chat-supported-agent'

export type NativeChatAccountSelectorProps = {
  agent?: NativeChatSupportedAgent
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

function getTriggerDisplayLabel(account: AntigravityAccountSummary | null): string {
  if (!account) {
    return ''
  }
  return account.alias?.trim() || account.email?.trim() || ''
}

function getAccountTooltip(account: AntigravityAccountSummary | null): string {
  if (!account) {
    return translate('accounts.antigravity.accounts', 'Google Accounts')
  }
  const email = account.email?.trim() || account.subject?.trim()
  const alias = account.alias?.trim()
  if (email && alias) {
    return `${email} (${alias})`
  }
  return email || alias || translate('accounts.antigravity.accounts', 'Google Accounts')
}

function getAccountItemLabel(account: AntigravityAccountSummary): string {
  const alias = account.alias?.trim()
  const email = account.email?.trim() || account.subject?.trim()
  if (alias && email) {
    return `${alias} (${email})`
  }
  return alias || email || translate('accounts.antigravity.saved', 'Saved Google account')
}

export function NativeChatAccountSelector({
  agent,
  open,
  onOpenChange
}: NativeChatAccountSelectorProps): React.JSX.Element | null {
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const { accounts } = useAntigravityAccounts()
  const activeAccount = useActiveWindowAntigravityAccount()

  const selectingRef = useRef(false)
  const addingRef = useRef(false)

  if (agent !== 'antigravity') {
    return null
  }

  const triggerLabel = getTriggerDisplayLabel(activeAccount)
  const tooltip = getAccountTooltip(activeAccount)

  const handleSelectAccount = async (accountId: string): Promise<void> => {
    if (selectingRef.current) {
      return
    }
    selectingRef.current = true
    try {
      await callAntigravityAccounts({ kind: 'local' }, { runtime: 'host' }, 'Select', accountId)
      await refreshAntigravityAccounts()
    } catch {
      // Best-effort selection update.
    } finally {
      selectingRef.current = false
    }
  }

  const handleAddAccount = async (): Promise<void> => {
    if (addingRef.current) {
      return
    }
    addingRef.current = true
    try {
      await callAntigravityAccounts({ kind: 'local' }, { runtime: 'host' }, 'AddCurrent')
      await refreshAntigravityAccounts()
    } catch {
      // Best-effort addition.
    } finally {
      addingRef.current = false
    }
  }

  const handleOpenSettings = (): void => {
    openSettingsTarget({ pane: 'accounts' })
    openSettingsPage()
  }

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={tooltip}
              data-testid="native-chat-account-selector-trigger"
              className="max-w-[160px]"
            >
              <AntigravityAccountBadgeIcon account={activeAccount} />
              {triggerLabel ? <span className="truncate">{triggerLabel}</span> : null}
              <ChevronDown className="size-3 shrink-0 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {tooltip}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" side="top" collisionPadding={8} className="w-56">
        <DropdownMenuLabel>
          {translate('accounts.antigravity.accounts', 'Google Accounts')}
        </DropdownMenuLabel>
        {accounts.map((account) => {
          const isSelected = activeAccount?.id === account.id
          return (
            <DropdownMenuItem
              key={account.id}
              data-testid={`native-chat-account-item-${account.id}`}
              className="justify-between"
              onSelect={() => {
                void handleSelectAccount(account.id)
              }}
              onClick={() => {
                void handleSelectAccount(account.id)
              }}
            >
              <span className="flex min-w-0 items-center gap-2 truncate">
                <AntigravityAccountBadgeIcon account={account} />
                <span className="truncate">{getAccountItemLabel(account)}</span>
              </span>
              {isSelected ? (
                <Check
                  className="size-3.5 shrink-0 text-foreground"
                  data-testid="account-selected-check"
                />
              ) : null}
            </DropdownMenuItem>
          )
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-testid="native-chat-account-add"
          onSelect={() => {
            void handleAddAccount()
          }}
          onClick={() => {
            void handleAddAccount()
          }}
        >
          <Plus className="size-3.5 text-muted-foreground" />
          <span>{translate('accounts.antigravity.addCurrent', 'Add Google account…')}</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="native-chat-account-settings"
          onSelect={handleOpenSettings}
          onClick={handleOpenSettings}
        >
          <Settings className="size-3.5 text-muted-foreground" />
          <span>{translate('accounts.antigravity.accountSettings', 'Account settings…')}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
