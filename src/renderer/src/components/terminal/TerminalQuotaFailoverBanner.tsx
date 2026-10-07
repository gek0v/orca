import { useLayoutEffect, useRef, useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useAntigravityAccounts } from '@/hooks/useAntigravityAccounts'
import { switchAntigravityAccountAndRestartSession } from '@/lib/antigravity-session-restart'
import { subscribeToPtyData } from '@/components/terminal-pane/pty-data-sidecar-subscriptions'

export const QUOTA_ERROR_PATTERNS = [
  /RESOURCE_EXHAUSTED/i,
  /429 Too Many Requests/i,
  /Quota exceeded/i,
  /Rate limit reached/i
] as const

export function isQuotaExhaustionError(text: string): boolean {
  return QUOTA_ERROR_PATTERNS.some((pattern) => pattern.test(text))
}

export type TerminalQuotaFailoverBannerProps = {
  activeAccount: { id: string; alias?: string | null; email?: string | null } | null
  alternateAccounts: { id: string; alias?: string | null; email?: string | null }[]
  hasQuotaExhaustionError: boolean
  onSwitchAndRestart: (accountId: string) => void | Promise<void>
  onDismiss?: () => void
}

function useReservePaneTopSpace(): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const banner = ref.current
    const pane = banner?.parentElement
    if (!banner || !pane) {
      return
    }
    const reserve = (): void => {
      pane.style.setProperty('--orca-pane-top-banner-height', `${banner.offsetHeight}px`)
    }
    reserve()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(reserve)
      observer.observe(banner)
      return () => {
        observer.disconnect()
        pane.style.removeProperty('--orca-pane-top-banner-height')
      }
    }
    return () => {
      pane.style.removeProperty('--orca-pane-top-banner-height')
    }
  }, [])
  return ref
}

export function TerminalQuotaFailoverBanner({
  activeAccount,
  alternateAccounts,
  hasQuotaExhaustionError,
  onSwitchAndRestart,
  onDismiss
}: TerminalQuotaFailoverBannerProps): React.JSX.Element | null {
  const ref = useReservePaneTopSpace()

  if (!hasQuotaExhaustionError) {
    return null
  }

  const activeLabel = activeAccount?.alias?.trim() || activeAccount?.email || 'Antigravity'
  const targetAccount = alternateAccounts[0]
  const targetLabel = targetAccount?.alias?.trim() || targetAccount?.email || 'Alternate account'

  return (
    <div
      ref={ref}
      role="status"
      className="pane-top-banner @container border-b border-status-warning-border bg-status-warning-background py-2 pr-16 pl-3 text-xs"
    >
      <div className="@[44rem]:flex @[44rem]:items-center @[44rem]:gap-2">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <TriangleAlert
            className="mt-0.5 size-4 shrink-0 text-status-warning"
            aria-hidden="true"
          />
          <div className="min-w-0 leading-5">
            <p className="font-medium text-foreground">
              {translate(
                'terminal.antigravityQuotaFailoverBanner.title',
                "Quota exhausted on '{{account}}'",
                { account: activeLabel }
              )}
            </p>
            <p className="text-muted-foreground">
              {targetAccount
                ? translate(
                    'terminal.antigravityQuotaFailoverBanner.alternateAvailable',
                    'Alternate account available: {{nextAccount}}. Switch now to resume without waiting for reset.',
                    { nextAccount: targetLabel }
                  )
                : translate(
                    'terminal.antigravityQuotaFailoverBanner.noAlternates',
                    'No alternate accounts configured. Add another account in Settings to enable instant failover.'
                  )}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1 @[44rem]:shrink-0 @max-[44rem]:mt-1.5 @max-[44rem]:pl-6.5">
          {targetAccount ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => void onSwitchAndRestart(targetAccount.id)}
            >
              {translate(
                'terminal.antigravityQuotaFailoverBanner.switchAndRestart',
                'Switch to {{account}} & Restart',
                { account: targetLabel }
              )}
            </Button>
          ) : null}
          <Button type="button" variant="ghost" size="xs" onClick={onDismiss}>
            {translate('terminal.antigravityQuotaFailoverBanner.dismiss', 'Dismiss')}
          </Button>
        </div>
      </div>
    </div>
  )
}

export function AntigravityTerminalQuotaPortal({
  ptyId,
  tabId,
  container
}: {
  ptyId: string
  tabId: string
  container: HTMLElement
}): React.JSX.Element | null {
  const [hasQuotaError, setHasQuotaError] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const { accounts, activeAccount } = useAntigravityAccounts()

  const tab = useAppStore((state) => {
    for (const tabs of Object.values(state.unifiedTabsByWorktree)) {
      const match = tabs.find((t) => t.contentType === 'terminal' && t.entityId === tabId)
      if (match) {
        return match
      }
    }
    return null
  })

  useEffect(() => {
    if (!ptyId || dismissed) {
      return
    }
    const unsubscribe = subscribeToPtyData(ptyId, (data) => {
      if (isQuotaExhaustionError(data)) {
        setHasQuotaError(true)
      }
    })
    return () => {
      unsubscribe()
    }
  }, [ptyId, dismissed])

  if (!hasQuotaError || dismissed) {
    return null
  }

  const currentTabAccountId = tab?.launchAccountId ?? activeAccount?.id
  const currentActive = accounts.find((a) => a.id === currentTabAccountId) ?? activeAccount
  const alternates = accounts.filter((a) => a.id !== currentActive?.id)

  const handleSwitchAndRestart = async (targetAccountId: string) => {
    try {
      await switchAntigravityAccountAndRestartSession({
        targetAccountId,
        tabId
      })
      toast.success(
        translate(
          'accounts.antigravity.switchedAndRestarted',
          'Switched Antigravity account and restarted session'
        )
      )
      setHasQuotaError(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not switch Antigravity account')
    }
  }

  return createPortal(
    <TerminalQuotaFailoverBanner
      activeAccount={currentActive}
      alternateAccounts={alternates}
      hasQuotaExhaustionError={hasQuotaError}
      onSwitchAndRestart={handleSwitchAndRestart}
      onDismiss={() => {
        setDismissed(true)
        setHasQuotaError(false)
      }}
    />,
    container,
    `antigravity-quota-${ptyId}`
  )
}
