// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { DockedGoalBar } from './DockedGoalBar'
import type { Goal } from '../../../../shared/goals/goals-schema'

describe('DockedGoalBar', () => {
  const writeClipboardText = vi.fn().mockResolvedValue(undefined)
  const ptyWrite = vi.fn()

  beforeEach(() => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Mock window.api for happy-dom test environment.
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      ui: { writeClipboardText },
      pty: { write: ptyWrite },
      goals: {
        get: vi.fn().mockResolvedValue({ activeGoalId: null, goals: [] }),
        onChanged: vi.fn().mockReturnValue(() => {}),
        createGoal: vi.fn(),
        setActive: vi.fn(),
        toggleSubtask: vi.fn(),
        updateGoal: vi.fn(),
        runValidation: vi.fn()
      }
    }
  })

  afterEach(() => {
    cleanup()
  })

  it('renders active goal title and progress bar', () => {
    const mockGoal: Goal = {
      id: 'g-1',
      title: 'Active Goal Title',
      status: 'in_progress',
      subtasks: [
        { id: 't-1', title: 'Task 1', completed: true },
        { id: 't-2', title: 'Task 2', completed: false }
      ],
      createdAt: 1,
      updatedAt: 1
    }
    render(<DockedGoalBar activeGoal={mockGoal} worktreeId="wt-1" />)
    expect(screen.getByText('Active Goal Title')).toBeDefined()
    expect(screen.getByText('1/2')).toBeDefined()
  })

  it('renders subtle define goal button when no active goal exists', () => {
    render(<DockedGoalBar activeGoal={null} worktreeId="wt-1" />)
    expect(screen.getByText('+ Definir meta')).toBeDefined()
  })

  it('renders validation status badge for success', () => {
    const mockGoal: Goal = {
      id: 'g-1',
      title: 'Validating Goal',
      status: 'in_progress',
      subtasks: [{ id: 't-1', title: 'Task 1', completed: true }],
      validation: {
        command: 'pnpm test',
        status: 'success',
        exitCode: 0,
        summaryTail: 'All tests passed'
      },
      createdAt: 1,
      updatedAt: 1
    }
    render(<DockedGoalBar activeGoal={mockGoal} worktreeId="wt-1" />)
    expect(screen.getByText('Exitosa')).toBeDefined()
  })

  it('renders validation status badge for failed', () => {
    const mockGoal: Goal = {
      id: 'g-1',
      title: 'Failed Validation Goal',
      status: 'failed',
      subtasks: [{ id: 't-1', title: 'Task 1', completed: false }],
      validation: {
        command: 'pnpm test',
        status: 'failed',
        exitCode: 1,
        summaryTail: '1 test failed'
      },
      createdAt: 1,
      updatedAt: 1
    }
    render(<DockedGoalBar activeGoal={mockGoal} worktreeId="wt-1" />)
    expect(screen.getByText('Fallida')).toBeDefined()
  })

  it('renders validation status badge for running', () => {
    const mockGoal: Goal = {
      id: 'g-1',
      title: 'Running Validation Goal',
      status: 'in_verification',
      subtasks: [{ id: 't-1', title: 'Task 1', completed: false }],
      validation: {
        command: 'pnpm test',
        status: 'running'
      },
      createdAt: 1,
      updatedAt: 1
    }
    render(<DockedGoalBar activeGoal={mockGoal} worktreeId="wt-1" />)
    expect(screen.getByText('Ejecutando')).toBeDefined()
  })

  it('triggers quick assist and copies instruction to clipboard when no pty is bound', async () => {
    const mockGoal: Goal = {
      id: 'g-1',
      title: 'Quick Assist Goal',
      status: 'in_progress',
      subtasks: [
        { id: 't-1', title: 'First completed', completed: true },
        { id: 't-2', title: 'Next pending task', completed: false }
      ],
      createdAt: 1,
      updatedAt: 1
    }
    render(<DockedGoalBar activeGoal={mockGoal} worktreeId="wt-1" />)
    const assistBtn = screen.getByRole('button', { name: /asistir/i })
    fireEvent.click(assistBtn)

    expect(writeClipboardText).toHaveBeenCalledWith('Continúa con la tarea: "Next pending task"')
  })
})
