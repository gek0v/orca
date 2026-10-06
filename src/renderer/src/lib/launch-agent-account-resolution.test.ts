import { describe, expect, it } from 'vitest'
import { resolveDefaultLaunchAccountId } from './launch-agent-account-resolution'

describe('resolveDefaultLaunchAccountId', () => {
  it('returns explicit account ID when provided', () => {
    const store = {
      repos: [{ id: 'repo-1', antigravityAccountId: 'acc-project' }]
    }
    const result = resolveDefaultLaunchAccountId(
      store,
      'antigravity',
      'repo-1::/main',
      'acc-explicit'
    )
    expect(result).toBe('acc-explicit')
  })

  it('returns undefined for non-antigravity agents', () => {
    const store = {
      repos: [{ id: 'repo-1', antigravityAccountId: 'acc-project' }]
    }
    const result = resolveDefaultLaunchAccountId(store, 'claude', 'repo-1::/main')
    expect(result).toBeUndefined()
  })

  it('resolves project default antigravityAccountId from repoId in worktreeId', () => {
    const store = {
      repos: [{ id: 'repo-1', antigravityAccountId: 'acc-project-default' }]
    }
    const result = resolveDefaultLaunchAccountId(store, 'antigravity', 'repo-1::/path/to/main')
    expect(result).toBe('acc-project-default')
  })

  it('resolves default account by scanning worktreesByRepo when repoId is not in worktreeId prefix', () => {
    const store = {
      repos: [{ id: 'repo-1', antigravityAccountId: 'acc-found-via-map' }],
      worktreesByRepo: {
        'repo-1': [{ id: 'custom-wt-id' }]
      }
    }
    const result = resolveDefaultLaunchAccountId(store, 'antigravity', 'custom-wt-id')
    expect(result).toBe('acc-found-via-map')
  })

  it('returns undefined when repo has no default account configured', () => {
    const store = {
      repos: [{ id: 'repo-1', antigravityAccountId: null }]
    }
    const result = resolveDefaultLaunchAccountId(store, 'antigravity', 'repo-1::/main')
    expect(result).toBeUndefined()
  })

  it('returns undefined when repos is empty or undefined', () => {
    const store = {}
    const result = resolveDefaultLaunchAccountId(store, 'antigravity', 'repo-1#main')
    expect(result).toBeUndefined()
  })
})
