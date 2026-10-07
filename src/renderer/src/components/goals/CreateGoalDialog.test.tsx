// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { CreateGoalDialog } from './CreateGoalDialog'
import type { GoalAiGenerated } from '../../../../shared/goals/goals-ai'

describe('CreateGoalDialog AI generation', () => {
  const mockOnSubmit = vi.fn().mockResolvedValue(undefined)
  const mockOnOpenChange = vi.fn()
  const mockOnGenerateWithAi = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders input for AI prompt when onGenerateWithAi is provided', () => {
    render(
      <CreateGoalDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        onSubmit={mockOnSubmit}
        onGenerateWithAi={mockOnGenerateWithAi}
      />
    )

    expect(screen.getByPlaceholderText('Describe lo que quieres lograr con IA...')).toBeDefined()
    expect(screen.getByRole('button', { name: /Generar con IA/i })).toBeDefined()
  })

  it('calls onGenerateWithAi and populates form fields when clicked', async () => {
    const aiResult: GoalAiGenerated = {
      title: 'Meta generada por IA',
      description: 'Descripción detallada creada por la IA',
      subtasks: ['Subtarea 1 generada', 'Subtarea 2 generada'],
      validationCommand: 'pnpm test --run'
    }

    mockOnGenerateWithAi.mockResolvedValue(aiResult)

    render(
      <CreateGoalDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        onSubmit={mockOnSubmit}
        onGenerateWithAi={mockOnGenerateWithAi}
      />
    )

    const aiInput = screen.getByPlaceholderText('Describe lo que quieres lograr con IA...')
    fireEvent.change(aiInput, { target: { value: 'Crear módulo de autenticación' } })

    const aiButton = screen.getByRole('button', { name: /Generar con IA/i })
    fireEvent.click(aiButton)

    await waitFor(() => {
      expect(mockOnGenerateWithAi).toHaveBeenCalledWith('Crear módulo de autenticación')
    })

    await waitFor(() => {
      expect(screen.getByDisplayValue('Meta generada por IA')).toBeDefined()
    })

    expect(screen.getByDisplayValue('Descripción detallada creada por la IA')).toBeDefined()
    expect(screen.getByDisplayValue(/Subtarea 1 generada/)).toBeDefined()
    expect(screen.getByDisplayValue('pnpm test --run')).toBeDefined()
  })

  it('submits form with populated AI data', async () => {
    const aiResult: GoalAiGenerated = {
      title: 'Meta generada',
      description: 'Descripción IA',
      subtasks: ['Paso 1', 'Paso 2'],
      validationCommand: 'pnpm test'
    }

    mockOnGenerateWithAi.mockResolvedValue(aiResult)

    render(
      <CreateGoalDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        onSubmit={mockOnSubmit}
        onGenerateWithAi={mockOnGenerateWithAi}
      />
    )

    const aiInput = screen.getByPlaceholderText('Describe lo que quieres lograr con IA...')
    fireEvent.change(aiInput, { target: { value: 'Prompt de prueba' } })
    fireEvent.click(screen.getByRole('button', { name: /Generar con IA/i }))

    await waitFor(() => {
      expect(screen.getByDisplayValue('Meta generada')).toBeDefined()
    })

    const submitBtn = screen.getByRole('button', { name: 'Crear objetivo' })
    fireEvent.click(submitBtn)

    await waitFor(() => {
      expect(mockOnSubmit).toHaveBeenCalledWith({
        title: 'Meta generada',
        description: 'Descripción IA',
        subtasks: ['Paso 1', 'Paso 2'],
        validationCommand: 'pnpm test',
        setActiveImmediately: true
      })
    })
  })
})
