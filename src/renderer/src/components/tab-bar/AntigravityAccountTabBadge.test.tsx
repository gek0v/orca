import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AntigravityAccountTabBadge } from './AntigravityAccountTabBadge'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

describe('AntigravityAccountTabBadge', () => {
  it('renders color dot and alias label when account exists', () => {
    const account = {
      id: 'acc-1',
      email: 'work@company.com',
      subject: 'sub-1',
      authMethod: 'oauth',
      alias: 'Trabajo',
      color: '#3b82f6',
      createdAt: 0,
      updatedAt: 0
    }
    const html = renderToStaticMarkup(<AntigravityAccountTabBadge account={account} />)
    expect(html).toContain('Trabajo')
    expect(html).toContain('data-account-color="#3b82f6"')
  })

  it('falls back to email prefix and default color if alias/color are absent', () => {
    const account = {
      id: 'acc-2',
      email: 'personal@gmail.com',
      subject: 'sub-2',
      authMethod: 'oauth',
      createdAt: 0,
      updatedAt: 0
    }
    const html = renderToStaticMarkup(<AntigravityAccountTabBadge account={account} />)
    expect(html).toContain('personal')
    expect(html).toContain('data-account-color="#3b82f6"')
  })

  it('renders emoji instead of color dot when emoji is present', () => {
    const account = {
      id: 'acc-3',
      email: 'work@company.com',
      subject: 'sub-3',
      authMethod: 'oauth',
      alias: 'Trabajo',
      emoji: '💼',
      createdAt: 0,
      updatedAt: 0
    }
    const html = renderToStaticMarkup(<AntigravityAccountTabBadge account={account} />)
    expect(html).toContain('Trabajo')
    expect(html).toContain('data-account-emoji="💼"')
    expect(html).not.toContain('data-account-color')
  })

  it('renders only the indicator without text label in compact mode', () => {
    const account = {
      id: 'acc-1',
      email: 'work@company.com',
      subject: 'sub-1',
      authMethod: 'oauth',
      alias: 'Trabajo',
      color: '#3b82f6',
      createdAt: 0,
      updatedAt: 0
    }
    const html = renderToStaticMarkup(<AntigravityAccountTabBadge account={account} compact />)
    expect(html).toContain('data-account-color="#3b82f6"')
    expect(html).not.toContain('max-w-[54px]')
    // Tooltip content still has the alias
    expect(html).toContain('Trabajo')
  })

  it('renders nothing when account is null or undefined', () => {
    const html = renderToStaticMarkup(<AntigravityAccountTabBadge account={null} />)
    expect(html).toBe('')
  })
})
