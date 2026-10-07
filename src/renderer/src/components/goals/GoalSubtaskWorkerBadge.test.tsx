// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { GoalSubtaskWorkerBadge } from './GoalSubtaskWorkerBadge'
import type { GoalSubtaskWorker } from '../../../../shared/goals/goals-schema'

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick
  }: {
    children: React.ReactNode
    onClick?: () => void
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  )
}))

describe('GoalSubtaskWorkerBadge', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders nothing when no worker and no onAssignWorker is provided', () => {
    const { container } = render(<GoalSubtaskWorkerBadge />)
    expect(container.firstChild).toBeNull()
  })

  it('renders read-only badge when worker is provided without onAssignWorker', () => {
    const worker: GoalSubtaskWorker = {
      workerId: 'w-1',
      agent: 'claude',
      status: 'running'
    }
    render(<GoalSubtaskWorkerBadge worker={worker} />)
    expect(screen.getByText('claude')).toBeDefined()
  })

  it('renders assign button when onAssignWorker is provided without worker', () => {
    const onAssignWorker = vi.fn()
    render(<GoalSubtaskWorkerBadge onAssignWorker={onAssignWorker} />)
    expect(screen.getByText('+ Worker')).toBeDefined()
  })

  it('opens dropdown and allows selecting an agent', () => {
    const onAssignWorker = vi.fn()
    render(<GoalSubtaskWorkerBadge onAssignWorker={onAssignWorker} />)

    const trigger = screen.getByText('+ Worker')
    fireEvent.click(trigger)

    expect(screen.getByText('Asignar agente')).toBeDefined()
    const codexOption = screen.getByText('codex')
    fireEvent.click(codexOption)

    expect(onAssignWorker).toHaveBeenCalledWith('codex')
  })

  it('renders active worker agent name and status', () => {
    const worker: GoalSubtaskWorker = {
      workerId: 'w-2',
      agent: 'antigravity',
      status: 'completed'
    }
    const onAssignWorker = vi.fn()
    render(<GoalSubtaskWorkerBadge worker={worker} onAssignWorker={onAssignWorker} />)

    expect(screen.getAllByText('antigravity').length).toBeGreaterThan(0)
  })
})
