// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemePresetSelector } from './ThemePresetSelector'

describe('ThemePresetSelector', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount()
      })
    }
    container?.remove()
    container = null
    root = null
  })

  it('renders dark presets when effectiveMode is dark', () => {
    const onChange = vi.fn()
    act(() => {
      root?.render(<ThemePresetSelector value="default" onChange={onChange} effectiveMode="dark" />)
    })

    const buttons = container?.querySelectorAll('button[role="radio"]')
    expect(buttons?.length).toBeGreaterThanOrEqual(7)

    const draculaBtn = Array.from(buttons ?? []).find((b) => b.textContent?.includes('Dracula'))
    expect(draculaBtn).toBeDefined()
  })

  it('renders light presets when effectiveMode is light', () => {
    const onChange = vi.fn()
    act(() => {
      root?.render(
        <ThemePresetSelector value="default" onChange={onChange} effectiveMode="light" />
      )
    })

    const buttons = container?.querySelectorAll('button[role="radio"]')
    const latteBtn = Array.from(buttons ?? []).find((b) =>
      b.textContent?.includes('Catppuccin Latte')
    )
    expect(latteBtn).toBeDefined()
  })

  it('calls onChange when clicking a preset', () => {
    const onChange = vi.fn()
    act(() => {
      root?.render(<ThemePresetSelector value="default" onChange={onChange} effectiveMode="dark" />)
    })

    const buttons = container?.querySelectorAll('button[role="radio"]')
    const draculaBtn = Array.from(buttons ?? []).find((b) => b.textContent?.includes('Dracula'))

    expect(draculaBtn).toBeInstanceOf(HTMLButtonElement)
    if (draculaBtn instanceof HTMLButtonElement) {
      act(() => {
        draculaBtn.click()
      })
    }

    expect(onChange).toHaveBeenCalledWith('dracula')
  })

  it('sets aria-checked on selected preset', () => {
    act(() => {
      root?.render(<ThemePresetSelector value="nord" onChange={vi.fn()} effectiveMode="dark" />)
    })

    const buttons = container?.querySelectorAll('button[role="radio"]')
    const nordBtn = Array.from(buttons ?? []).find((b) => b.textContent?.includes('Nord'))
    expect(nordBtn?.getAttribute('aria-checked')).toBe('true')
  })
})
