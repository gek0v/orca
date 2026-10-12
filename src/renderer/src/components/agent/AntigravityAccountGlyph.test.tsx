import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AntigravityAccountGlyph, resolveAntigravityAccountGlyph } from './AntigravityAccountGlyph'

describe('AntigravityAccountGlyph', () => {
  describe('resolveAntigravityAccountGlyph', () => {
    it('returns custom emoji when account has an emoji', () => {
      const res = resolveAntigravityAccountGlyph({
        id: '1',
        email: 'test@example.com',
        subject: 'sub',
        authMethod: 'oauth',
        emoji: '🚀',
        createdAt: 0,
        updatedAt: 0
      })
      expect(res).toEqual({ text: '🚀', isEmoji: true })
    })

    it('returns custom character text when account has non-emoji emoji string', () => {
      const res = resolveAntigravityAccountGlyph({
        id: '1',
        email: 'test@example.com',
        subject: 'sub',
        authMethod: 'oauth',
        emoji: 'DEV',
        createdAt: 0,
        updatedAt: 0
      })
      expect(res).toEqual({ text: 'DEV', isEmoji: false })
    })

    it('derives initial letter from alias when emoji is not set', () => {
      const res = resolveAntigravityAccountGlyph({
        id: '1',
        email: 'test@example.com',
        subject: 'sub',
        authMethod: 'oauth',
        alias: 'Trabajo',
        createdAt: 0,
        updatedAt: 0
      })
      expect(res).toEqual({ text: 'T', isEmoji: false })
    })

    it('derives initial letter from email prefix when alias and emoji are not set', () => {
      const res = resolveAntigravityAccountGlyph({
        id: '1',
        email: 'personal@example.com',
        subject: 'sub',
        authMethod: 'oauth',
        createdAt: 0,
        updatedAt: 0
      })
      expect(res).toEqual({ text: 'P', isEmoji: false })
    })

    it('derives initial from fallbackText when account has no identifiers', () => {
      const res = resolveAntigravityAccountGlyph(null, 'CustomAccount')
      expect(res).toEqual({ text: 'C', isEmoji: false })
    })

    it('defaults to A when neither account nor fallbackText are provided', () => {
      const res = resolveAntigravityAccountGlyph(null)
      expect(res).toEqual({ text: 'A', isEmoji: false })
    })
  })

  describe('render markup', () => {
    it('renders emoji element with data-account-emoji', () => {
      const html = renderToStaticMarkup(
        <AntigravityAccountGlyph
          account={{
            id: '1',
            email: 'test@example.com',
            subject: 'sub',
            authMethod: 'oauth',
            emoji: '⚡',
            createdAt: 0,
            updatedAt: 0
          }}
        />
      )
      expect(html).toContain('data-account-emoji="⚡"')
      expect(html).toContain('data-account-glyph="⚡"')
      expect(html).not.toContain('data-account-character')
      expect(html).toContain('⚡')
    })

    it('renders character element with data-account-character when falling back', () => {
      const html = renderToStaticMarkup(
        <AntigravityAccountGlyph
          account={{
            id: '1',
            email: 'work@example.com',
            subject: 'sub',
            authMethod: 'oauth',
            alias: 'Work',
            createdAt: 0,
            updatedAt: 0
          }}
        />
      )
      expect(html).toContain('data-account-character="W"')
      expect(html).toContain('data-account-glyph="W"')
      expect(html).not.toContain('data-account-emoji')
      expect(html).toContain('W')
    })

    it('applies xs sizing classes', () => {
      const html = renderToStaticMarkup(<AntigravityAccountGlyph fallbackText="Dev" size="xs" />)
      expect(html).toContain('size-3')
      expect(html).toContain('text-[8.5px]')
    })

    it('applies md sizing classes for emoji', () => {
      const html = renderToStaticMarkup(
        <AntigravityAccountGlyph
          account={{
            id: '1',
            email: 'test@example.com',
            subject: 'sub',
            authMethod: 'oauth',
            emoji: '🤖',
            createdAt: 0,
            updatedAt: 0
          }}
          size="md"
        />
      )
      expect(html).toContain('text-sm')
    })
  })
})
