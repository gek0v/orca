import React from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'
import { translate } from '@/i18n/i18n'

export function AntigravitySwitchConfirmDialog({
  open,
  onOpenChange,
  accountName,
  hasActiveSession,
  isSwitching,
  onConfirm,
  onCancel
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  accountName: string
  hasActiveSession: boolean
  isSwitching: boolean
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]" {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}>
        <DialogHeader>
          <DialogTitle>
            {translate('accounts.antigravity.switchConfirmTitle', 'Switch Antigravity account?')}
          </DialogTitle>
          <DialogDescription>
            {hasActiveSession
              ? translate(
                  'accounts.antigravity.switchConfirmActiveSession',
                  'Switching to {{account}} will close your active Antigravity session and open a new conversation with the selected account. Are you sure you want to continue?',
                  { account: accountName }
                )
              : translate(
                  'accounts.antigravity.switchConfirmNoSession',
                  'Are you sure you want to switch the active Antigravity account to {{account}}?',
                  { account: accountName }
                )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={isSwitching}>
            {translate('common.cancel', 'Cancel')}
          </Button>
          <Button onClick={onConfirm} disabled={isSwitching}>
            {hasActiveSession
              ? translate(
                  'accounts.antigravity.switchConfirmActionRestart',
                  'Switch & restart session'
                )
              : translate('accounts.antigravity.switchConfirmAction', 'Switch account')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
