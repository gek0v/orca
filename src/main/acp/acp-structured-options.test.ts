import { describe, expect, it } from 'vitest'
import { AcpStructuredOptions } from './acp-structured-options'
import { ANTIGRAVITY_ACP_DIALECT } from './acp-dialects/antigravity-dialect'

describe('AcpStructuredOptions', () => {
  it('handles default ACP models and configOptions without dialect', () => {
    const options = new AcpStructuredOptions()
    options.adoptSession({
      configOptions: [
        {
          id: 'thought_level',
          category: 'thought_level',
          name: 'Reasoning Effort',
          type: 'select',
          currentValue: 'medium',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' }
          ]
        }
      ],
      models: {
        currentModelId: 'custom-model',
        availableModels: [{ modelId: 'custom-model', name: 'Custom Model' }]
      }
    })

    const read = options.read()
    expect(read.current.model).toBe('custom-model')
    expect(read.current.effort).toBe('medium')
    expect(options.write('effort', 'low')).toEqual({
      method: 'config',
      configId: 'thought_level',
      value: 'low'
    })
  })

  it('normalizes Antigravity model variants and efforts when configured with ANTIGRAVITY_ACP_DIALECT', () => {
    const options = new AcpStructuredOptions(ANTIGRAVITY_ACP_DIALECT)
    options.adoptSession({
      models: {
        currentModelId: 'gemini-3.8-flash-high',
        availableModels: [
          { modelId: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low Reasoning)' },
          { modelId: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium Reasoning)' },
          { modelId: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High Reasoning)' },
          { modelId: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro (Low Reasoning)' },
          { modelId: 'gemini-pro-agent', name: 'Gemini 3.1 Pro (High Reasoning)' }
        ]
      }
    })

    const read = options.read()
    expect(read.current.model).toBe('gemini-3.8-flash')
    expect(read.current.effort).toBe('high')
    expect(read.models).toHaveLength(2)

    // Verify option write for effort resolves to variant
    const writeEffort = options.write('effort', 'low')
    expect(writeEffort).toEqual({
      method: 'model',
      modelId: 'gemini-3.8-flash-low'
    })

    // Simulate model update on server
    options.adoptModel('gemini-3.8-flash-low')
    expect(options.reported()).toEqual({
      model: 'gemini-3.8-flash',
      effort: 'low'
    })

    // Verify option write for model resolves to variant preserving current effort
    const writeModel = options.write('model', 'gemini-3.1-pro')
    expect(writeModel).toEqual({
      method: 'model',
      modelId: 'gemini-3.1-pro-low'
    })
  })
})
