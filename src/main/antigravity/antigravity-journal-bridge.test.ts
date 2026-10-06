import { describe, it, expect } from 'vitest'
import { AntigravityJournalBridge } from './antigravity-journal-bridge'

describe('AntigravityJournalBridge', () => {
  it('translates USER_EXPLICIT input into user message and starts a turn', () => {
    const bridge = new AntigravityJournalBridge({ sessionId: 'session-1', now: () => 1000 })
    const items = bridge.translateStep({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: 'Hello Antigravity'
    })

    expect(items).toHaveLength(1)
    const item = items[0]
    expect(item.itemId).toBe('agy-session-1-0-0')
    expect(item.sequence).toBe(1)
    expect(item.turnScope).toEqual({ kind: 'turn', turnItemId: 'turn-session-1-0' })

    expect(item.body.kind).toBe('message')
    if (item.body.kind === 'message') {
      expect(item.body.role).toBe('user')
      expect(item.body.blocks).toEqual([{ type: 'text', text: 'Hello Antigravity' }])
    }
  })

  it('translates thinking and assistant response in PLANNER_RESPONSE', () => {
    const bridge = new AntigravityJournalBridge({ sessionId: 'session-2', now: () => 2000 })

    // Establish turn first
    bridge.translateStep({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: 'Solve problem'
    })

    const items = bridge.translateStep({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      thinking: 'Let me think about how to solve this...',
      content: 'Here is the solution to your problem.'
    })

    expect(items).toHaveLength(2)

    // Reasoning item
    const reasoningItem = items[0]
    expect(reasoningItem.body.kind).toBe('message')
    if (reasoningItem.body.kind === 'message') {
      expect(reasoningItem.body.role).toBe('reasoning')
      expect(reasoningItem.body.blocks[0]).toEqual({
        type: 'text',
        text: 'Let me think about how to solve this...'
      })
    }

    // Assistant item
    const assistantItem = items[1]
    expect(assistantItem.body.kind).toBe('message')
    if (assistantItem.body.kind === 'message') {
      expect(assistantItem.body.role).toBe('assistant')
      expect(assistantItem.body.blocks[0]).toEqual({
        type: 'text',
        text: 'Here is the solution to your problem.'
      })
    }
  })

  it('translates tool calls into tool-call items with bounded payloads', () => {
    const bridge = new AntigravityJournalBridge({ sessionId: 'session-3', now: () => 3000 })

    const items = bridge.translateStep({
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      tool_calls: [
        {
          name: 'view_file',
          args: { AbsolutePath: '/tmp/test.txt' }
        }
      ]
    })

    expect(items).toHaveLength(1)
    const item = items[0]
    expect(item.body.kind).toBe('tool-call')
    if (item.body.kind === 'tool-call') {
      expect(item.body.name).toBe('view_file')
      expect(item.body.input).toEqual({ AbsolutePath: '/tmp/test.txt' })
      expect(item.body.output?.truncated).toBe(false)
      expect(item.body.state).toBe('completed')
    }
  })

  it('translates tool output in USER_INPUT to role tool', () => {
    const bridge = new AntigravityJournalBridge({ sessionId: 'session-4', now: () => 4000 })

    const items = bridge.translateStep({
      step_index: 3,
      source: 'SYSTEM',
      type: 'USER_INPUT',
      content: 'File content read successfully.'
    })

    expect(items).toHaveLength(1)
    expect(items[0].body.kind).toBe('message')
    if (items[0].body.kind === 'message') {
      expect(items[0].body.role).toBe('tool')
      expect(items[0].body.blocks[0]).toEqual({ type: 'text', text: 'File content read successfully.' })
    }
  })

  it('resets sequence and turn on reset()', () => {
    const bridge = new AntigravityJournalBridge({ sessionId: 'session-5', now: () => 5000 })
    bridge.translateStep({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: 'Turn 1'
    })

    bridge.reset()

    const items = bridge.translateStep({
      step_index: 0,
      source: 'SYSTEM',
      type: 'USER_INPUT',
      content: 'System notice'
    })

    expect(items[0].sequence).toBe(1)
    expect(items[0].turnScope).toEqual({ kind: 'thread' })
  })
})
