// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import GoalsPage from './GoalsPage'
import type { Goal } from '../../../../shared/goals/goals-schema'
import type { Worktree } from '../../../../shared/worktree/types'
import { useAppStore } from '../../store'
import type * as StoreModule from '../../store'

vi.mock('../../store', async (importOriginal) => {
  const actual = await importOriginal<typeof StoreModule>()
  return actual
})

describe('GoalsPage', () => {
  const mockCloseGoalsPage = vi.fn()
  const mockCreateGoal = vi.fn()
  const mockDeleteGoal = vi.fn()
  const mockSetActive = vi.fn()
  const mockToggleSubtask = vi.fn()
  const mockUpdateGoal = vi.fn()
  const mockRunValidation = vi.fn()

  const mockGoals: Goal[] = [
    {
      id: 'g-1',
      title: 'First Goal',
      description: 'Goal description',
      status: 'in_progress',
      subtasks: [
        { id: 't-1', title: 'Task 1', completed: true },
        { id: 't-2', title: 'Task 2', completed: false }
      ],
      validation: {
        command: 'pnpm test',
        status: 'success',
        exitCode: 0,
        summaryTail: '1 passed'
      },
      createdAt: 1000,
      updatedAt: 1000
    }
  ]

  beforeEach(() => {
    vi.clearAllMocks()

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Mock window.api for happy-dom test environment.
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      goals: {
        get: vi.fn().mockResolvedValue({
          activeGoalId: 'g-1',
          goals: mockGoals
        }),
        onChanged: vi.fn().mockReturnValue(() => {}),
        createGoal: mockCreateGoal.mockResolvedValue(mockGoals[0]),
        deleteGoal: mockDeleteGoal.mockResolvedValue(undefined),
        setActive: mockSetActive.mockResolvedValue(undefined),
        toggleSubtask: mockToggleSubtask.mockResolvedValue(undefined),
        updateGoal: mockUpdateGoal.mockResolvedValue(undefined),
        runValidation: mockRunValidation.mockResolvedValue({
          command: 'pnpm test',
          status: 'success'
        })
      }
    }

    useAppStore.setState({
      activeWorktreeId: 'wt-1',
      closeGoalsPage: mockCloseGoalsPage,
      worktreesByRepo: {
        'repo-1': [
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Mock worktree for testing.
          {
            id: 'wt-1',
            repoId: 'repo-1',
            path: '/path/to/worktree',
            displayName: 'test-worktree'
          } as unknown as Worktree
        ]
      }
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('renders goals page header and goal card', async () => {
    render(<GoalsPage />)

    expect(screen.getByText('Objetivos')).toBeDefined()
    expect(screen.getByText('Nuevo objetivo')).toBeDefined()

    await waitFor(() => {
      expect(screen.getByText('First Goal')).toBeDefined()
    })

    expect(screen.getByText('Meta activa')).toBeDefined()
    expect(screen.getByText('Task 1')).toBeDefined()
    expect(screen.getByText('Task 2')).toBeDefined()
    expect(screen.getByText('pnpm test')).toBeDefined()
  })

  it('toggles a subtask completion when clicked', async () => {
    render(<GoalsPage />)

    await waitFor(() => {
      expect(screen.getByText('Task 2')).toBeDefined()
    })

    const checkboxes = screen.getAllByRole('checkbox')
    // Task 2 is the second checkbox in the tasks list
    const task2Checkbox = checkboxes[1]
    fireEvent.click(task2Checkbox)

    await waitFor(() => {
      expect(mockToggleSubtask).toHaveBeenCalledWith({
        workspacePath: '/path/to/worktree',
        goalId: 'g-1',
        subtaskId: 't-2',
        completed: true
      })
    })
  })

  it('calls deleteGoal when trash icon is clicked', async () => {
    render(<GoalsPage />)

    await waitFor(() => {
      expect(screen.getByText('First Goal')).toBeDefined()
    })

    const deleteBtn = screen.getByTitle('Eliminar objetivo')
    fireEvent.click(deleteBtn)

    await waitFor(() => {
      expect(mockDeleteGoal).toHaveBeenCalledWith({
        workspacePath: '/path/to/worktree',
        goalId: 'g-1'
      })
    })
  })

  it('opens dialog to create a new goal', async () => {
    render(<GoalsPage />)

    const newGoalBtn = screen.getByText('Nuevo objetivo')
    fireEvent.click(newGoalBtn)

    expect(screen.getByText('Crear nuevo objetivo')).toBeDefined()
    const input = screen.getByPlaceholderText('ej. Implementar autenticación OAuth')
    fireEvent.change(input, { target: { value: 'New Test Goal' } })

    const submitBtn = screen.getByRole('button', { name: 'Crear objetivo' })
    fireEvent.click(submitBtn)

    await waitFor(() => {
      expect(mockCreateGoal).toHaveBeenCalledWith(
        expect.objectContaining({
          workspacePath: '/path/to/worktree',
          title: 'New Test Goal'
        })
      )
    })
  })
})
