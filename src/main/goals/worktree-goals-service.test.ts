import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { WorktreeGoalsService } from './worktree-goals-service'
import { WorktreeGoalsManager, worktreeGoalsManager } from './worktree-goals-manager'
import { resolveGitExcludePath, ensureGitExclusion } from './worktree-goals-path'
import { gitExecFileAsync } from '../git/runner'
import type { WorkspaceGoalsData } from '../../shared/goals/goals-schema'

describe('WorktreeGoalsService', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-goals-test-'))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('initializes empty goals file when none exists', async () => {
    const service = new WorktreeGoalsService(tempDir)
    const data = await service.loadGoals()
    expect(data.activeGoalId).toBeNull()
    expect(data.goals).toEqual([])

    const fileContent = await fs.readFile(path.join(tempDir, '.orca', 'goals.json'), 'utf8')
    expect(JSON.parse(fileContent)).toEqual({ activeGoalId: null, goals: [] })
    service.dispose()
  })

  it('writes goals atomically and projects CURRENT_GOAL.md with rules', async () => {
    const service = new WorktreeGoalsService(tempDir)
    await service.saveGoals({
      activeGoalId: 'g-1',
      goals: [
        {
          id: 'g-1',
          title: 'My Goal',
          description: 'A description',
          status: 'in_progress',
          subtasks: [
            { id: 't-1', title: 'First subtask', completed: true },
            { id: 't-2', title: 'Second subtask', completed: false }
          ],
          validation: {
            command: 'pnpm test',
            status: 'failed',
            exitCode: 1,
            summaryTail: 'Error: test failed at line 10\nExpected 1 but got 0'
          },
          createdAt: 100,
          updatedAt: 100
        }
      ]
    })

    const mdPath = path.join(tempDir, '.orca', 'CURRENT_GOAL.md')
    const mdContent = await fs.readFile(mdPath, 'utf8')
    expect(mdContent).toContain('# Objetivo Activo: My Goal')
    expect(mdContent).toContain('**Estado:** En curso')
    expect(mdContent).toContain('- [x] 1. First subtask')
    expect(mdContent).toContain('- [ ] 2. Second subtask')
    expect(mdContent).toContain('## Validación Técnica')
    expect(mdContent).toContain('- Comando: `pnpm test`')
    expect(mdContent).toContain('Fallido (exit code: 1)')
    expect(mdContent).toContain('Error: test failed at line 10')
    expect(mdContent).toContain('*(Log completo disponible en `.orca/last_validation.log`')
    expect(mdContent).toContain('orca goal complete')
    expect(mdContent).toContain('NO modifiques manualmente el archivo .orca/goals.json')
    service.dispose()
  })

  it('suppresses watcher loop when content hash matches and notifies on external changes', async () => {
    const service = new WorktreeGoalsService(tempDir)
    await service.loadGoals()

    const receivedUpdates: WorkspaceGoalsData[] = []
    const unsubscribe = service.onExternalChange((data) => {
      receivedUpdates.push(data)
    })

    // Saving via service should update lastWrittenContentHash and suppress notifications
    await service.saveGoals({
      activeGoalId: 'g-1',
      goals: [
        {
          id: 'g-1',
          title: 'Internal Update',
          status: 'in_progress',
          subtasks: [],
          createdAt: 100,
          updatedAt: 100
        }
      ]
    })

    // Give watcher time to fire if it were to incorrectly fire
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(receivedUpdates).toHaveLength(0)

    // Now perform an external write to goals.json directly
    const externalData: WorkspaceGoalsData = {
      activeGoalId: 'g-2',
      goals: [
        {
          id: 'g-2',
          title: 'External Update',
          status: 'completed',
          subtasks: [{ id: 'st-1', title: 'External task', completed: true }],
          createdAt: 200,
          updatedAt: 300
        }
      ]
    }
    await fs.writeFile(
      path.join(tempDir, '.orca', 'goals.json'),
      JSON.stringify(externalData, null, 2),
      'utf8'
    )

    // Wait for watcher to pick up external change
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(receivedUpdates.length).toBeGreaterThanOrEqual(1)
    expect(receivedUpdates[0]?.activeGoalId).toBe('g-2')

    unsubscribe()
    service.dispose()
  })

  it('serializes concurrent updates without lost updates', async () => {
    const service = new WorktreeGoalsService(tempDir)
    await service.saveGoals({
      activeGoalId: 'g-1',
      goals: [
        {
          id: 'g-1',
          title: 'Concurrency Test',
          status: 'in_progress',
          subtasks: [],
          createdAt: 100,
          updatedAt: 100
        }
      ]
    })

    // Trigger 5 concurrent updates
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        service.updateGoals((current) => {
          const goal = current.goals.find((g) => g.id === 'g-1')!
          return {
            ...current,
            goals: [
              {
                ...goal,
                subtasks: [
                  ...goal.subtasks,
                  { id: `task-${i}`, title: `Task ${i}`, completed: false }
                ]
              }
            ]
          }
        })
      )
    )

    const reloaded = await service.loadGoals()
    const goal = reloaded.goals.find((g) => g.id === 'g-1')!
    expect(goal.subtasks).toHaveLength(5)
    service.dispose()
  })
})

describe('worktree-goals-path & git exclusion', () => {
  let mainRepoDir: string
  let worktreeDir: string

  beforeEach(async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-git-test-'))
    mainRepoDir = path.join(baseDir, 'main-repo')
    worktreeDir = path.join(baseDir, 'linked-worktree')

    await fs.mkdir(mainRepoDir, { recursive: true })
    await gitExecFileAsync(['init', '-q', '-b', 'main'], { cwd: mainRepoDir })
    await gitExecFileAsync(['config', 'user.name', 'Orca Test'], { cwd: mainRepoDir })
    await gitExecFileAsync(['config', 'user.email', 'orca@example.com'], { cwd: mainRepoDir })
    await fs.writeFile(path.join(mainRepoDir, 'README.md'), '# Test', 'utf8')
    await gitExecFileAsync(['add', 'README.md'], { cwd: mainRepoDir })
    await gitExecFileAsync(['commit', '-m', 'Initial commit', '-q'], { cwd: mainRepoDir })

    // Create linked worktree
    await gitExecFileAsync(['worktree', 'add', '-b', 'feature-branch', worktreeDir], {
      cwd: mainRepoDir
    })
  })

  afterEach(async () => {
    await fs.rm(path.dirname(mainRepoDir), { recursive: true, force: true }).catch(() => {})
  })

  it('resolves git exclude path in linked worktree without throwing ENOTDIR', async () => {
    // In a linked worktree, .git is a file, not a directory
    const stat = await fs.stat(path.join(worktreeDir, '.git'))
    expect(stat.isFile()).toBe(true)

    // Directly trying to write to <worktree>/.git/info/exclude would throw ENOTDIR
    await expect(
      fs.mkdir(path.join(worktreeDir, '.git', 'info'), { recursive: true })
    ).rejects.toThrow()

    // resolveGitExcludePath resolves to the common git dir's info/exclude
    const excludePath = await resolveGitExcludePath(worktreeDir)
    expect(excludePath).not.toBeNull()
    expect(excludePath!.endsWith(path.join('info', 'exclude'))).toBe(true)

    // Ensure exclusion adds .orca/ to info/exclude
    await ensureGitExclusion(worktreeDir)
    const excludeContent = await fs.readFile(excludePath!, 'utf8')
    expect(excludeContent).toContain('.orca/')

    // .gitignore must remain untouched
    const gitignoreExists = await fs
      .access(path.join(worktreeDir, '.gitignore'))
      .then(() => true)
      .catch(() => false)
    expect(gitignoreExists).toBe(false)
  })

  it('handles folder workspace gracefully when .git does not exist', async () => {
    const plainFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-plain-folder-'))
    const excludePath = await resolveGitExcludePath(plainFolder)
    expect(excludePath).toBeNull()

    // ensureGitExclusion should complete cleanly without throwing
    await expect(ensureGitExclusion(plainFolder)).resolves.toBeUndefined()
    await fs.rm(plainFolder, { recursive: true, force: true })
  })
})

describe('WorktreeGoalsManager', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-manager-test-'))
  })

  afterEach(async () => {
    worktreeGoalsManager.disposeAll()
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('caches services by normalized path and disposes them', async () => {
    const manager = new WorktreeGoalsManager()
    const service1 = manager.getService(tempDir)
    const service2 = manager.getService(path.resolve(tempDir))
    expect(service1).toBe(service2)

    manager.disposeService(tempDir)
    const service3 = manager.getService(tempDir)
    expect(service3).not.toBe(service1)

    manager.disposeAll()
  })
})
