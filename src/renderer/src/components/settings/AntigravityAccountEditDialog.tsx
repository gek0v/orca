import { useState, useEffect } from 'react'
import { Smile, X } from 'lucide-react'
import EmojiPicker, { EmojiStyle, Theme, type EmojiClickData } from 'emoji-picker-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import type { AntigravityAccountSummary } from '../../../../shared/antigravity-account-types'

export const ANTIGRAVITY_ACCOUNT_PALETTE = [
  { id: 'blue', value: '#3b82f6', label: 'Blue' },
  { id: 'emerald', value: '#10b981', label: 'Emerald' },
  { id: 'purple', value: '#8b5cf6', label: 'Purple' },
  { id: 'amber', value: '#f59e0b', label: 'Amber' },
  { id: 'rose', value: '#f43f5e', label: 'Rose' },
  { id: 'cyan', value: '#06b6d4', label: 'Cyan' }
] as const

export type AntigravityAccountEditDialogProps = {
  account: AntigravityAccountSummary | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (
    accountId: string,
    metadata: { alias?: string | null; color?: string | null; emoji?: string | null }
  ) => Promise<void>
}

export function AntigravityAccountEditDialog({
  account,
  open,
  onOpenChange,
  onSave
}: AntigravityAccountEditDialogProps): React.JSX.Element {
  const [alias, setAlias] = useState('')
  const [selectedColor, setSelectedColor] = useState<string>(ANTIGRAVITY_ACCOUNT_PALETTE[0].value)
  const [selectedEmoji, setSelectedEmoji] = useState<string | null>(null)
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const settingsTheme = useAppStore((state) => state.settings?.theme ?? 'system')
  const systemPrefersDark = useSystemPrefersDark()
  const isDarkTheme = settingsTheme === 'dark' || (settingsTheme === 'system' && systemPrefersDark)

  useEffect(() => {
    if (account) {
      setAlias(account.alias ?? '')
      setSelectedColor(account.color ?? ANTIGRAVITY_ACCOUNT_PALETTE[0].value)
      setSelectedEmoji(account.emoji ?? null)
    }
  }, [account, open])

  const handleEmojiClick = (emojiData: EmojiClickData): void => {
    const emoji = emojiData.emoji
    if (emoji && emoji.length <= 16) {
      setSelectedEmoji(emoji)
      setEmojiPickerOpen(false)
    }
  }

  const handleSave = async () => {
    if (!account) {
      return
    }
    setSaving(true)
    try {
      await onSave(account.id, {
        alias: alias.trim() || null,
        color: selectedColor || null,
        emoji: selectedEmoji?.trim() || null
      })
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translate('accounts.antigravity.editTitle', 'Edit account details')}
          </DialogTitle>
          <DialogDescription>
            {account?.email ??
              account?.subject ??
              translate('accounts.antigravity.saved', 'Saved Google account')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <label className="text-xs font-medium text-foreground">
              {translate('accounts.antigravity.aliasLabel', 'Account alias')}
            </label>
            <div className="flex items-center gap-2">
              <Popover open={emojiPickerOpen} onOpenChange={setEmojiPickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    data-testid="selected-account-emoji"
                    aria-label="Account icon emoji"
                    className="shrink-0"
                    disabled={saving}
                  >
                    {selectedEmoji ? (
                      <span className="text-base select-none leading-none">{selectedEmoji}</span>
                    ) : (
                      <Smile />
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto" align="start">
                  <EmojiPicker
                    autoFocusSearch={false}
                    emojiStyle={EmojiStyle.NATIVE}
                    height={320}
                    lazyLoadEmojis
                    onEmojiClick={handleEmojiClick}
                    previewConfig={{ showPreview: false }}
                    theme={isDarkTheme ? Theme.DARK : Theme.LIGHT}
                  />
                </PopoverContent>
              </Popover>
              {selectedEmoji ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  data-testid="clear-account-emoji"
                  aria-label="Clear emoji"
                  onClick={() => setSelectedEmoji(null)}
                  className="shrink-0"
                >
                  <X />
                </Button>
              ) : null}
              <Input
                placeholder={translate('accounts.antigravity.aliasPlaceholder', 'Account alias')}
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                disabled={saving}
                maxLength={32}
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium text-foreground">
              {translate('accounts.antigravity.colorLabel', 'Account color')}
            </label>
            <div className="flex items-center gap-3">
              {ANTIGRAVITY_ACCOUNT_PALETTE.map((preset) => {
                const isSelected = selectedColor === preset.value
                return (
                  <button
                    key={preset.id}
                    type="button"
                    data-testid={`color-${preset.id}`}
                    aria-label={preset.label}
                    onClick={() => setSelectedColor(preset.value)}
                    className="size-7 rounded-full transition-transform focus:outline-none"
                    style={{
                      backgroundColor: preset.value,
                      boxShadow: isSelected ? `0 0 0 2px var(--background), 0 0 0 4px ${preset.value}` : undefined,
                      transform: isSelected ? 'scale(1.15)' : 'scale(1)'
                    }}
                  />
                )
              })}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {translate('common.cancel', 'Cancel')}
          </Button>
          <Button type="button" onClick={() => void handleSave()} disabled={saving}>
            {translate('common.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
