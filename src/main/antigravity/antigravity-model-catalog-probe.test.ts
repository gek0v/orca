import { describe, expect, it, vi } from 'vitest'
import { createAntigravityModelCatalogProbe } from './antigravity-model-catalog-probe'

describe('createAntigravityModelCatalogProbe', () => {
  it('delegates to runProbe test seam when provided', async () => {
    const runProbeMock = vi.fn().mockResolvedValue({
      models: [
        {
          id: 'gemini-3.8-flash',
          label: 'Gemini 3.8 Flash',
          isDefault: true,
          efforts: [{ value: 'high', label: 'High' }]
        }
      ],
      fastModeTierByModel: new Map(),
      origin: 'probe'
    })

    const probe = createAntigravityModelCatalogProbe({
      runProbe: runProbeMock
    })

    const result = await probe('/test/account/home')
    expect(runProbeMock).toHaveBeenCalledWith('/test/account/home')
    expect(result.models).toHaveLength(1)
    expect(result.models[0]?.id).toBe('gemini-3.8-flash')
    expect(result.origin).toBe('probe')
  })

  it('returns seeded catalog models when no runProbe seam is provided', async () => {
    const probe = createAntigravityModelCatalogProbe({})
    const result = await probe('/test/home')
    expect(result.models.length).toBeGreaterThanOrEqual(1)
    expect(result.models.some((m) => m.id === 'gemini-2.5-pro')).toBe(true)
    expect(result.origin).toBe('probe')
  })
})
