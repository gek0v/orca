import { useId, useState } from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'
import type { Repo } from '../../../../shared/repo-types'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { translate } from '@/i18n/i18n'
import { searchKeywords } from './settings-search-keywords'
import { refreshAntigravityAccounts, useAntigravityAccounts } from '@/hooks/useAntigravityAccounts'

export type RepositoryAntigravityAccountSectionProps = {
  repo: Repo
  updateRepo: (repoId: string, updates: { antigravityAccountId?: string | null }) => unknown
  forceVisible?: boolean
}

export const AMBIENT_ANTIGRAVITY_ACCOUNT_VALUE = '__ambient_antigravity_account__'

export function RepositoryAntigravityAccountSection({
  repo,
  updateRepo,
  forceVisible
}: RepositoryAntigravityAccountSectionProps): React.JSX.Element {
  const { accounts, activeAccount } = useAntigravityAccounts()
  const [refreshing, setRefreshing] = useState(false)
  const selectLabelId = useId()

  const selectedAccountId = repo.antigravityAccountId ?? null
  const selectedAccount = selectedAccountId
    ? (accounts.find((acc) => acc.id === selectedAccountId) ?? null)
    : null
  const isMissingAccount = Boolean(selectedAccountId && !selectedAccount)

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await refreshAntigravityAccounts()
    } finally {
      setRefreshing(false)
    }
  }

  const handleValueChange = (value: string) => {
    if (value === AMBIENT_ANTIGRAVITY_ACCOUNT_VALUE) {
      if (repo.antigravityAccountId) {
        void Promise.resolve(updateRepo(repo.id, { antigravityAccountId: null }))
      }
      return
    }
    if (value !== repo.antigravityAccountId) {
      void Promise.resolve(updateRepo(repo.id, { antigravityAccountId: value }))
    }
  }

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.repository.antigravityAccount.title',
        'Default Antigravity Account'
      )}
      description={translate(
        'auto.components.settings.repository.antigravityAccount.description',
        'Choose the default account profile used when launching Antigravity sessions and agents in this project.'
      )}
      keywords={searchKeywords([
        repo.displayName,
        'antigravity',
        'account',
        'profile',
        'perfil',
        'cuenta',
        'gemini',
        {
          key: 'auto.components.settings.repository.search.antigravityAccountKeyword',
          fallback: 'antigravity account'
        }
      ])}
      className="space-y-3"
      forceVisible={forceVisible}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="text-sm font-semibold">
            {translate(
              'auto.components.settings.repository.antigravityAccount.title',
              'Default Antigravity Account'
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.repository.antigravityAccount.longDescription',
              'Sessions and agents launched within this repository will use this account profile by default unless explicitly overridden.'
            )}
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <span id={selectLabelId} className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.repository.antigravityAccount.selectLabel',
              'Account profile'
            )}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            aria-label={translate(
              'auto.components.settings.repository.antigravityAccount.refresh',
              'Refresh Antigravity accounts'
            )}
            title={translate(
              'auto.components.settings.repository.antigravityAccount.refresh',
              'Refresh Antigravity accounts'
            )}
            className="size-6 shrink-0"
          >
            <RefreshCw className={refreshing ? 'size-3.5 animate-spin' : 'size-3.5'} />
          </Button>
        </div>

        <Select
          value={
            repo.antigravityAccountId
              ? repo.antigravityAccountId
              : AMBIENT_ANTIGRAVITY_ACCOUNT_VALUE
          }
          onValueChange={handleValueChange}
        >
          <SelectTrigger size="sm" className="w-full" aria-labelledby={selectLabelId}>
            <SelectValue
              placeholder={translate(
                'auto.components.settings.repository.antigravityAccount.selectPlaceholder',
                'Select an account'
              )}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AMBIENT_ANTIGRAVITY_ACCOUNT_VALUE}>
              {translate(
                'auto.components.settings.repository.antigravityAccount.ambient',
                'Ambient active account'
              )}
              {activeAccount
                ? ` (${activeAccount.alias || activeAccount.email || activeAccount.id})`
                : ''}
            </SelectItem>
            {isMissingAccount && selectedAccountId ? (
              <SelectItem value={selectedAccountId} disabled>
                {translate(
                  'auto.components.settings.repository.antigravityAccount.missingOption',
                  'Missing account ({{id}})',
                  { id: selectedAccountId }
                )}
              </SelectItem>
            ) : null}
            {accounts.map((acc) => {
              const label = acc.alias
                ? `${acc.alias} (${acc.email || acc.id})`
                : acc.email || acc.id
              return (
                <SelectItem key={acc.id} value={acc.id}>
                  {acc.emoji ? `${acc.emoji} ` : ''}
                  {label}
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>

        {isMissingAccount ? (
          <div className="flex items-center gap-1.5 pt-1 text-xs text-destructive">
            <AlertCircle className="size-3.5 shrink-0" />
            <span>
              {translate(
                'auto.components.settings.repository.antigravityAccount.notFound',
                'Bound account not found on this machine. Falling back to ambient account.'
              )}
            </span>
          </div>
        ) : null}
      </div>
    </SearchableSetting>
  )
}
