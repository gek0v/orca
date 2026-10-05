// @vitest-environment happy-dom

import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AntigravityAccountEditDialog } from './AntigravityAccountEditDialog'
import type { AntigravityAccountSummary } from '../../../../shared/antigravity-account-types'

const testAccount: AntigravityAccountSummary = {
  id: 'acc-1',
  email: 'test@example.com',
  subject: 'sub-1',
  authMethod: 'oauth',
  alias: 'Personal',
  color: '#3b82f6',
  emoji: '🚀',
  createdAt: 1000,
  updatedAt: 1000
}

describe('AntigravityAccountEditDialog', () => {
  afterEach(cleanup)
  it('displays the existing emoji and saves modified emoji', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      <AntigravityAccountEditDialog
        account={testAccount}
        open={true}
        onOpenChange={vi.fn()}
        onSave={onSave}
      />
    )

    expect(screen.getByTestId('selected-account-emoji').textContent).toContain('🚀')
    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    expect(onSave).toHaveBeenCalledWith('acc-1', {
      alias: 'Personal',
      color: '#3b82f6',
      emoji: '🚀'
    })
  })

  it('allows removing the emoji', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      <AntigravityAccountEditDialog
        account={testAccount}
        open={true}
        onOpenChange={vi.fn()}
        onSave={onSave}
      />
    )

    fireEvent.click(screen.getByTestId('clear-account-emoji'))
    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    expect(onSave).toHaveBeenCalledWith('acc-1', {
      alias: 'Personal',
      color: '#3b82f6',
      emoji: null
    })
  })
})
