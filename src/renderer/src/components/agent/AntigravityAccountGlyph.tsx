import React from 'react'
import type { AntigravityAccountSummary } from '../../../../shared/antigravity-account-types'
import { cn } from '@/lib/utils'

export type AntigravityAccountGlyphSize = 'xs' | 'sm' | 'md'

export type AntigravityAccountGlyphProps = {
  account?: AntigravityAccountSummary | null
  fallbackText?: string | null
  size?: AntigravityAccountGlyphSize
  className?: string
}

const EMOJI_PATTERN = /\p{Extended_Pictographic}/u

export function resolveAntigravityAccountGlyph(
  account?: AntigravityAccountSummary | null,
  fallbackText?: string | null
): { text: string; isEmoji: boolean } {
  const custom = account?.emoji?.trim()
  if (custom) {
    return {
      text: custom,
      isEmoji: EMOJI_PATTERN.test(custom)
    }
  }

  const name =
    account?.alias?.trim() || account?.email?.split('@')[0]?.trim() || fallbackText?.trim() || ''

  if (name) {
    return {
      text: name.charAt(0).toUpperCase(),
      isEmoji: false
    }
  }

  return {
    text: 'A',
    isEmoji: false
  }
}

const SIZE_CHARACTER_CLASSES: Record<AntigravityAccountGlyphSize, string> = {
  xs: 'size-3 text-[8.5px] leading-none',
  sm: 'size-3.5 text-[9.5px] leading-none',
  md: 'size-5 text-[11px] leading-none'
}

const SIZE_EMOJI_CLASSES: Record<AntigravityAccountGlyphSize, string> = {
  xs: 'text-[10px] leading-none',
  sm: 'text-[12px] leading-none',
  md: 'text-sm leading-none'
}

export function AntigravityAccountGlyph({
  account,
  fallbackText,
  size = 'sm',
  className
}: AntigravityAccountGlyphProps): React.JSX.Element {
  const { text, isEmoji } = resolveAntigravityAccountGlyph(account, fallbackText)

  if (isEmoji) {
    return (
      <span
        aria-hidden="true"
        data-account-glyph={text}
        data-account-emoji={text}
        className={cn(
          'inline-flex items-center justify-center select-none shrink-0',
          SIZE_EMOJI_CLASSES[size],
          className
        )}
      >
        {text}
      </span>
    )
  }

  return (
    <span
      aria-hidden="true"
      data-account-glyph={text}
      data-account-character={text}
      className={cn(
        'inline-flex items-center justify-center rounded select-none shrink-0 font-semibold uppercase tabular-nums text-foreground bg-muted/70 border border-border/60',
        SIZE_CHARACTER_CLASSES[size],
        className
      )}
    >
      {text}
    </span>
  )
}
