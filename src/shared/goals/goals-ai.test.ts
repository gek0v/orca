import { describe, it, expect } from 'vitest'
import { buildGoalAiPrompt, parseGoalAiResponse } from './goals-ai'

describe('goals-ai', () => {
  it('builds a prompt containing user request and schema', () => {
    const prompt = buildGoalAiPrompt('Implement OAuth login')
    expect(prompt).toContain('User Request: "Implement OAuth login"')
    expect(prompt).toContain('"subtasks"')
    expect(prompt).toContain('"validationCommand"')
  })

  it('parses pure JSON response', () => {
    const json = JSON.stringify({
      title: 'OAuth Auth',
      description: 'Support Google and GitHub',
      subtasks: ['Setup routes', 'Store tokens'],
      validationCommand: 'pnpm test src/auth'
    })

    const parsed = parseGoalAiResponse(json)
    expect(parsed.title).toBe('OAuth Auth')
    expect(parsed.subtasks).toEqual(['Setup routes', 'Store tokens'])
    expect(parsed.validationCommand).toBe('pnpm test src/auth')
  })

  it('parses fenced markdown JSON response', () => {
    const raw = `Here is the plan:
\`\`\`json
{
  "title": "Migrate DB",
  "subtasks": ["Create migration", "Run migration"]
}
\`\`\``

    const parsed = parseGoalAiResponse(raw)
    expect(parsed.title).toBe('Migrate DB')
    expect(parsed.subtasks).toHaveLength(2)
  })

  it('heuristically extracts markdown list fallback', () => {
    const raw = `Setup Payment Gateway
Integrate Stripe API
1. Create webhook handler
2. Add checkout session
3. Test webhooks`

    const parsed = parseGoalAiResponse(raw, 'Setup Payment')
    expect(parsed.title).toBe('Setup Payment Gateway')
    expect(parsed.subtasks).toEqual([
      'Create webhook handler',
      'Add checkout session',
      'Test webhooks'
    ])
  })
})
