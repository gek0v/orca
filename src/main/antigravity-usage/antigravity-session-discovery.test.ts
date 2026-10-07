import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  discoverAntigravitySessions,
  getAntigravityRootDirs,
  normalizeWorkspaceUri,
  readAntigravityDefaultModel,
  readHistoryWorkspaces
} from './antigravity-session-discovery'

describe('antigravity-session-discovery', () => {
  const testDir = join(process.cwd(), 'scratch-discovery-test')

  beforeEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('normalizeWorkspaceUri converts file URIs correctly', () => {
    if (process.platform === 'win32') {
      expect(normalizeWorkspaceUri('file:///C:/projects/orca')).toBe('C:\\projects\\orca')
    } else {
      expect(normalizeWorkspaceUri('file:///home/user/orca')).toBe('/home/user/orca')
    }
    expect(normalizeWorkspaceUri('relative/path')).toBe('relative/path')
  })

  it('getAntigravityRootDirs prioritizes customRootDirs', () => {
    const custom = ['/custom/antigravity']
    expect(getAntigravityRootDirs({ customRootDirs: custom })).toEqual(custom)
  })

  it('readAntigravityDefaultModel reads model from settings.json', () => {
    writeFileSync(join(testDir, 'settings.json'), JSON.stringify({ model: 'gemini-2.5-pro' }))
    expect(readAntigravityDefaultModel(testDir)).toBe('gemini-2.5-pro')

    writeFileSync(join(testDir, 'settings.json'), 'invalid json')
    expect(readAntigravityDefaultModel(testDir)).toBeNull()
  })

  it('readHistoryWorkspaces reads workspaces from history.jsonl', () => {
    const historyPath = join(testDir, 'history.jsonl')
    const lines = [
      JSON.stringify({ conversationId: 'conv-1', workspace: '/path/to/repo1' }),
      JSON.stringify({ conversationId: 'conv-2', workspace: '/path/to/repo2' })
    ]
    writeFileSync(historyPath, lines.join('\n'))

    const workspaces = readHistoryWorkspaces(testDir)
    expect(workspaces.get('conv-1')).toBe('/path/to/repo1')
    expect(workspaces.get('conv-2')).toBe('/path/to/repo2')
  })

  it('discoverAntigravitySessions finds sessions in brain directory', () => {
    const brainDir = join(testDir, 'brain')
    const convId = 'test-session-123'
    const logsDir = join(brainDir, convId, '.system_generated', 'logs')
    mkdirSync(logsDir, { recursive: true })
    writeFileSync(join(logsDir, 'transcript.jsonl'), '{"step_index": 1}\n')

    writeFileSync(
      join(testDir, 'history.jsonl'),
      JSON.stringify({ conversationId: convId, workspace: '/test/workspace' })
    )
    writeFileSync(join(testDir, 'settings.json'), JSON.stringify({ model: 'gemini-2.5-flash' }))

    const sessions = discoverAntigravitySessions({ customRootDirs: [testDir] })
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.sessionId).toBe(convId)
    expect(sessions[0]?.cwd).toBe('/test/workspace')
    expect(sessions[0]?.model).toBe('gemini-2.5-flash')
  })
})
