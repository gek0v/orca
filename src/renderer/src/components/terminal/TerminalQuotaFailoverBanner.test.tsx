// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalQuotaFailoverBanner, isQuotaExhaustionError } from './TerminalQuotaFailoverBanner'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, value),
      fallback
    )
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

afterEach(() => cleanup())

describe('TerminalQuotaFailoverBanner', () => {
  it('renders nothing when hasQuotaExhaustionError is false', () => {
    const { container } = render(
      <TerminalQuotaFailoverBanner
        activeAccount={{ id: 'acc-1', alias: 'Trabajo' }}
        alternateAccounts={[{ id: 'acc-2', alias: 'Personal' }]}
        hasQuotaExhaustionError={false}
        onSwitchAndRestart={vi.fn()}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('detects quota exhaustion in output and displays switch action to alternate account', () => {
    const onSwitch = vi.fn()
    const { container } = render(
      <TerminalQuotaFailoverBanner
        activeAccount={{ id: 'acc-1', alias: 'Trabajo' }}
        alternateAccounts={[{ id: 'acc-2', alias: 'Personal' }]}
        hasQuotaExhaustionError={true}
        onSwitchAndRestart={onSwitch}
      />
    )
    expect(container.textContent).toContain("Quota exhausted on 'Trabajo'")
    fireEvent.click(screen.getByText('Switch to Personal & Restart'))
    expect(onSwitch).toHaveBeenCalledWith('acc-2')
  })

  it('triggers onDismiss when Dismiss button is clicked', () => {
    const onDismiss = vi.fn()
    render(
      <TerminalQuotaFailoverBanner
        activeAccount={{ id: 'acc-1', alias: 'Trabajo' }}
        alternateAccounts={[{ id: 'acc-2', alias: 'Personal' }]}
        hasQuotaExhaustionError={true}
        onSwitchAndRestart={vi.fn()}
        onDismiss={onDismiss}
      />
    )
    fireEvent.click(screen.getByText('Dismiss'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('falls back to email or default label if alias is absent', () => {
    const { container } = render(
      <TerminalQuotaFailoverBanner
        activeAccount={{ id: 'acc-1', email: 'work@gmail.com' }}
        alternateAccounts={[{ id: 'acc-2', email: 'personal@gmail.com' }]}
        hasQuotaExhaustionError={true}
        onSwitchAndRestart={vi.fn()}
      />
    )
    expect(container.textContent).toContain("Quota exhausted on 'work@gmail.com'")
    expect(screen.getByText('Switch to personal@gmail.com & Restart')).toBeTruthy()
  })

  it('recognizes various quota error patterns correctly', () => {
    expect(isQuotaExhaustionError('Error: 429 Too Many Requests')).toBe(true)
    expect(
      isQuotaExhaustionError('rpc error: code = ResourceExhausted desc = Quota exceeded')
    ).toBe(true)
    expect(isQuotaExhaustionError('Rate limit reached for models/gemini-pro')).toBe(true)
    expect(isQuotaExhaustionError('RESOURCE_EXHAUSTED: daily limit')).toBe(true)
    expect(isQuotaExhaustionError('Normal terminal output running tests')).toBe(false)
  })
})
