import React from 'react'
import { Search, X } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

export function AntigravityAccountSearchInput({
  query,
  onQueryChange
}: {
  query: string
  onQueryChange: (query: string) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 max-w-xs">
      <Search className="size-3.5 shrink-0 text-muted-foreground" />
      <Input
        type="text"
        placeholder={translate('accounts.antigravity.searchPlaceholder', 'Filter accounts...')}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        className="h-8 flex-1"
      />
      {query ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => onQueryChange('')}
          aria-label={translate('accounts.antigravity.clearSearch', 'Clear search')}
        >
          <X className="size-3 text-muted-foreground" />
        </Button>
      ) : null}
    </div>
  )
}
