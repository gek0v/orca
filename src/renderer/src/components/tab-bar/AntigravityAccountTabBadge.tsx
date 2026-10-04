import React from 'react'
import type { AntigravityAccountSummary } from '../../../../shared/antigravity-account-types'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export type AntigravityAccountTabBadgeProps = {
  account?: AntigravityAccountSummary | null
}

const DEFAULT_ACCOUNT_COLOR = '#3b82f6'

export function AntigravityAccountTabBadge({
  account
}: AntigravityAccountTabBadgeProps): React.JSX.Element | null {
  if (!account) {
    return null
  }

  const label = account.alias?.trim() || account.email?.split('@')[0] || 'Antigravity'
  const color = account.color?.trim() || DEFAULT_ACCOUNT_COLOR

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex items-center gap-1 shrink-0 select-none mr-1">
          <span
            className="size-1.5 rounded-full shrink-0"
            style={{ backgroundColor: color }}
            data-account-color={color}
          />
          <span className="max-w-[54px] truncate text-[10px] font-medium text-muted-foreground">
            {label}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        <p className="font-semibold">{account.alias || 'Antigravity'}</p>
        {account.email ? <p className="text-muted-foreground">{account.email}</p> : null}
      </TooltipContent>
    </Tooltip>
  )
}
