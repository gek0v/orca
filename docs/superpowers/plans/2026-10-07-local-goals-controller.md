# Local Goals Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a local, worktree-isolated goals and iterative milestones controller in Orca, featuring passive LLM context injection, an extensible CLI interface, background validation runner, and a docked goal progress bar in the workbench UI.

**Architecture:** Atomic, worktree-isolated JSON persistence (`.orca/goals.json`) synchronized with git worktree exclusions (`info/exclude`), projected to a lightweight LLM-readable summary (`.orca/CURRENT_GOAL.md`) with full validation logs saved separately (`.orca/last_validation.log`). Coordinated by a Main process service with concurrency mutex and file-hash loop prevention, exposed via Orca CLI (`orca goal ...`) and typed IPC to a shadcn-styled docked goal bar in the renderer.

**Tech Stack:** TypeScript, Node.js / Electron, Zod, Vitest, React, Zustand, Tailwind CSS, shadcn UI.

**Spec:** `docs/superpowers/specs/2026-10-07-local-goals-controller-design.md`

## Global Constraints

- Use `git rev-parse --git-path info/exclude` to resolve exclude files in linked worktrees; do not assume `.git` is a directory.
- Execute validation commands through platform shells (`cmd.exe /d /s /c` on Windows, `/bin/sh -c` on POSIX) using `runProcess` with `windowsHide: true`.
- Guard `fs.watch` against feedback loops by comparing SHA-256 hashes of written content (`lastWrittenContentHash`).
- Limit `.orca/CURRENT_GOAL.md` validation snippets to the last 5-10 lines of output to protect LLM context windows; save full outputs to `.orca/last_validation.log`.
- Disallow direct JSON modification by agents in `CURRENT_GOAL.md`; route all agent updates through the Orca CLI (`orca goal ...`).
- Respect `STYLEGUIDE.md` tokens and use existing shadcn primitives from `src/renderer/src/components/ui/`.
- No vague file names (`helpers`, `utils`, `common`).

## Review Focus

1. **Linked Git Worktree `.git` file vs directory:** Attempting to write to `<root>/.git/info/exclude` in a linked worktree throws `ENOTDIR`; verified with a test using `git rev-parse --git-path info/exclude`.
2. **Compound shell commands in validation:** Commands with `&&` or pipes (e.g. `pnpm test && pnpm lint`) fail under raw spawn; verified with a test running compound scripts via platform shell resolution.
3. **Watcher self-trigger feedback loop:** Writing `.orca/goals.json` must not trigger an unnecessary `goals:changed` event back to the UI; verified with a test verifying hash suppression.
4. **LLM context window token exhaustion:** Validation outputs exceeding 50 KB must never be dumped verbatim into `CURRENT_GOAL.md`; verified by inspecting the projected file size and structure.
5. **Concurrent UI and CLI updates:** Multiple rapid status updates must not cause lost updates; verified with a serialization queue test.

---

### Task 1: Data Models, Zod Schemas & Shared Types

**Files:**
- Create: `src/shared/goals/goals-schema.ts`
- Test: `src/shared/goals/goals-schema.test.ts`

**Interfaces:**
- Produces: `GoalStatusSchema`, `GoalSubtaskSchema`, `GoalValidationSchema`, `GoalSchema`, `WorkspaceGoalsDataSchema`, and their TypeScript inferred types.

- [ ] **Step 1: Write the failing test**

```typescript
// src/shared/goals/goals-schema.test.ts
import { describe, it, expect } from 'vitest'
import {
  GoalSchema,
  WorkspaceGoalsDataSchema,
  GoalValidationSchema
} from './goals-schema'

describe('goals-schema', () => {
  it('validates a valid goal data structure', () => {
    const raw = {
      activeGoalId: 'goal-1',
      goals: [
        {
          id: 'goal-1',
          title: 'Implement Core Feature',
          description: 'Step-by-step implementation',
          status: 'in_progress',
          subtasks: [
            { id: 'task-1', title: 'Scaffold schema', completed: true },
            { id: 'task-2', title: 'Write tests', completed: false }
          ],
          validation: {
            command: 'pnpm test',
            status: 'idle',
            summaryTail: undefined
          },
          createdAt: 1000,
          updatedAt: 2000
        }
      ]
    }
    const parsed = WorkspaceGoalsDataSchema.parse(raw)
    expect(parsed.activeGoalId).toBe('goal-1')
    expect(parsed.goals[0].subtasks).toHaveLength(2)
  })

  it('rejects invalid goal status', () => {
    const invalid = {
      id: 'g-1',
      title: 'Invalid',
      status: 'unknown_status',
      subtasks: [],
      createdAt: 1,
      updatedAt: 2
    }
    expect(() => GoalSchema.parse(invalid)).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/shared/goals/goals-schema.test.ts`
Expected: FAIL with "Cannot find module './goals-schema'"

- [ ] **Step 3: Implement `src/shared/goals/goals-schema.ts`**

Define Zod schemas and export inferred types as documented in the specification.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/shared/goals/goals-schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/goals/goals-schema.ts src/shared/goals/goals-schema.test.ts
git commit -m "feat(goals): add shared zod schemas and types"
```

---

### Task 2: Persistence Service & Linked Worktree Isolation

**Files:**
- Create: `src/main/goals/worktree-goals-path.ts`
- Create: `src/main/goals/worktree-goals-service.ts`
- Create: `src/main/goals/worktree-goals-manager.ts`
- Test: `src/main/goals/worktree-goals-service.test.ts`

**Interfaces:**
- Consumes: `WorkspaceGoalsDataSchema`, `GoalSchema`, `WorkspaceGoalsData` from `src/shared/goals/goals-schema.ts`
- Produces: `WorktreeGoalsService` class with methods:
  - `loadGoals(): Promise<WorkspaceGoalsData>`
  - `saveGoals(data: WorkspaceGoalsData): Promise<void>`
  - `projectCurrentGoalFile(): Promise<void>`
  - `ensureGitExclusion(): Promise<void>`
  - `onExternalChange(callback: (data: WorkspaceGoalsData) => void): () => void`
  - `dispose(): void`

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/goals/worktree-goals-service.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { WorktreeGoalsService } from './worktree-goals-service'

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
          subtasks: [{ id: 't-1', title: 'Do task', completed: false }],
          createdAt: 100,
          updatedAt: 100
        }
      ]
    })

    const mdPath = path.join(tempDir, '.orca', 'CURRENT_GOAL.md')
    const mdContent = await fs.readFile(mdPath, 'utf8')
    expect(mdContent).toContain('# Objetivo Activo: My Goal')
    expect(mdContent).toContain('orca goal complete')
    expect(mdContent).toContain('NO modifiques manualmente el archivo .orca/goals.json')
    service.dispose()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/goals/worktree-goals-service.test.ts`
Expected: FAIL with "Cannot find module './worktree-goals-service'"

- [ ] **Step 3: Implement `worktree-goals-path.ts`, `worktree-goals-service.ts`, and `worktree-goals-manager.ts`**

Implement:
- `resolveGitExcludePath(workspacePath: string)` resolving via `git rev-parse --git-path info/exclude` or falling back to `.git` checking.
- Atomic file writes via `.tmp` rename.
- SHA-256 hash tracking for `lastWrittenContentHash` to suppress watcher loops.
- `projectCurrentGoalFile()` formatting markdown with short `summaryTail`.
- Mutex / promise queue for mutations.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/main/goals/worktree-goals-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/goals/worktree-goals-path.ts src/main/goals/worktree-goals-service.ts src/main/goals/worktree-goals-manager.ts src/main/goals/worktree-goals-service.test.ts
git commit -m "feat(goals): add worktree goals persistence service and manager"
```

---

### Task 3: Background Validation Runner

**Files:**
- Create: `src/main/goals/goals-validation-runner.ts`
- Test: `src/main/goals/goals-validation-runner.test.ts`

**Interfaces:**
- Consumes: `runProcess` from `src/shared/child-process/run-process`, `GoalValidation` from `src/shared/goals/goals-schema.ts`
- Produces: `GoalsValidationRunner` with `runValidation(workspacePath: string, command: string): Promise<GoalValidationResult>`

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/goals/goals-validation-runner.test.ts
import { describe, it, expect } from 'vitest'
import { GoalsValidationRunner } from './goals-validation-runner'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

describe('GoalsValidationRunner', () => {
  it('executes a shell command and captures exit code and log file', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-val-test-'))
    const runner = new GoalsValidationRunner()
    
    // Test command compatible across platforms
    const cmd = process.platform === 'win32' ? 'echo pass' : 'echo pass'
    const result = await runner.runValidation(tempDir, cmd)
    
    expect(result.exitCode).toBe(0)
    expect(result.status).toBe('success')
    
    // Full log file verification
    const logPath = path.join(tempDir, '.orca', 'last_validation.log')
    const logContent = await fs.readFile(logPath, 'utf8')
    expect(logContent).toContain('pass')
    
    await fs.rm(tempDir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/goals/goals-validation-runner.test.ts`
Expected: FAIL with "Cannot find module './goals-validation-runner'"

- [ ] **Step 3: Implement `GoalsValidationRunner`**

Use `runProcess` with platform shell resolution:
- Windows: `{ program: process.env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', command] }`
- POSIX: `{ program: '/bin/sh', args: ['-c', command] }`
Save full logs into `<workspace>/.orca/last_validation.log` and compute `summaryTail` (last 5-10 lines).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/main/goals/goals-validation-runner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/goals/goals-validation-runner.ts src/main/goals/goals-validation-runner.test.ts
git commit -m "feat(goals): add background goals validation runner"
```

---

### Task 4: IPC Layer and Main Process Handlers

**Files:**
- Create: `src/shared/goals/goals-ipc.ts`
- Create: `src/main/goals/goals-ipc-handlers.ts`
- Test: `src/main/goals/goals-ipc-handlers.test.ts`

**Interfaces:**
- Consumes: `WorktreeGoalsManager`, `GoalsValidationRunner`, `goals-schema.ts`
- Produces: Registered IPC channels and typed invoke/send wrappers for renderer and CLI.

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/goals/goals-ipc-handlers.test.ts
import { describe, it, expect, vi } from 'vitest'
import { registerGoalsIpcHandlers } from './goals-ipc-handlers'

describe('goals-ipc-handlers', () => {
  it('registers ipc handlers for goal operations', () => {
    const fakeIpcMain = {
      handle: vi.fn(),
      on: vi.fn()
    }
    const fakeManager = {} as any
    const fakeRunner = {} as any
    registerGoalsIpcHandlers(fakeIpcMain as any, fakeManager, fakeRunner)
    
    expect(fakeIpcMain.handle).toHaveBeenCalledWith('goals:get', expect.any(Function))
    expect(fakeIpcMain.handle).toHaveBeenCalledWith('goals:create-goal', expect.any(Function))
    expect(fakeIpcMain.handle).toHaveBeenCalledWith('goals:toggle-subtask', expect.any(Function))
    expect(fakeIpcMain.handle).toHaveBeenCalledWith('goals:run-validation', expect.any(Function))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/goals/goals-ipc-handlers.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/shared/goals/goals-ipc.ts` and `src/main/goals/goals-ipc-handlers.ts`**

Implement handlers connecting IPC to `WorktreeGoalsManager` and `GoalsValidationRunner`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/main/goals/goals-ipc-handlers.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/goals/goals-ipc.ts src/main/goals/goals-ipc-handlers.ts src/main/goals/goals-ipc-handlers.test.ts
git commit -m "feat(goals): add ipc channel contracts and main process handlers"
```

---

### Task 5: Orca CLI Command Suite (`orca goal ...`)

**Files:**
- Create: `src/cli/specs/goals.ts`
- Create: `src/cli/goals-dispatch.ts`
- Modify: `src/cli/specs/index.ts`
- Modify: `src/cli/dispatch.ts`
- Test: `src/cli/specs/goals.test.ts`

**Interfaces:**
- Produces: CLI commands:
  - `orca goal status [--json]`
  - `orca goal complete <id-or-index>`
  - `orca goal validate`
  - `orca goal add-task <title>`

- [ ] **Step 1: Write the failing test**

```typescript
// src/cli/specs/goals.test.ts
import { describe, it, expect } from 'vitest'
import { GOALS_COMMAND_SPEC } from './goals'

describe('GOALS_COMMAND_SPEC', () => {
  it('defines the goal command structure and subcommands', () => {
    expect(GOALS_COMMAND_SPEC.path).toEqual(['goal'])
    expect(GOALS_COMMAND_SPEC.summary).toBeDefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/cli/specs/goals.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement command specs and dispatch in `src/cli/specs/goals.ts` and `src/cli/goals-dispatch.ts`**

Hook up `orca goal` subcommands resolving the target workspace via `ORCA_CLI_CWD` / `process.cwd()`, executing operations via `WorktreeGoalsService` or runtime client.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/cli/specs/goals.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/specs/goals.ts src/cli/specs/goals.test.ts src/cli/goals-dispatch.ts src/cli/specs/index.ts src/cli/dispatch.ts
git commit -m "feat(cli): add orca goal command specs and dispatch"
```

---

### Task 6: Renderer UI: `DockedGoalBar` & Terminal Surface Integration

**Files:**
- Create: `src/renderer/src/components/goals/use-workspace-goals.ts`
- Create: `src/renderer/src/components/goals/GoalSegmentedProgress.tsx`
- Create: `src/renderer/src/components/goals/GoalSubtasksPopover.tsx`
- Create: `src/renderer/src/components/goals/GoalValidationBadge.tsx`
- Create: `src/renderer/src/components/goals/DockedGoalBar.tsx`
- Modify: `src/renderer/src/components/TerminalSurface.tsx`
- Test: `src/renderer/src/components/goals/DockedGoalBar.test.tsx`

**Interfaces:**
- Consumes: `useWorkspaceGoals`, shadcn UI primitives (`DropdownMenu`, `Popover`, `Checkbox`, `Button`, `Badge`, `Tooltip`), `TerminalSurface.tsx`

- [ ] **Step 1: Write the failing test**

```typescript
// src/renderer/src/components/goals/DockedGoalBar.test.tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DockedGoalBar } from './DockedGoalBar'

describe('DockedGoalBar', () => {
  it('renders active goal title and progress bar', () => {
    const mockGoal = {
      id: 'g-1',
      title: 'Active Goal Title',
      status: 'in_progress',
      subtasks: [
        { id: 't-1', title: 'Task 1', completed: true },
        { id: 't-2', title: 'Task 2', completed: false }
      ],
      createdAt: 1,
      updatedAt: 1
    }
    render(<DockedGoalBar activeGoal={mockGoal as any} worktreeId="wt-1" />)
    expect(screen.getByText('Active Goal Title')).toBeDefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/renderer/src/components/goals/DockedGoalBar.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement components in `src/renderer/src/components/goals/` and mount in `TerminalSurface.tsx`**

Build:
- `GoalSegmentedProgress.tsx`: segments with tooltips for subtasks.
- `GoalSubtasksPopover.tsx`: collapsible interactive checklist + add task input.
- `GoalValidationBadge.tsx`: traffic light status indicator + log popover.
- Quick assist button to pre-fill the active terminal prompt with the next pending subtask.
- Mount `DockedGoalBar` in `TerminalSurface.tsx` between `TerminalTitlebarTabs` and `TerminalSplitWorkspaceSurfaces`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/renderer/src/components/goals/DockedGoalBar.test.tsx`
Expected: PASS

- [ ] **Step 5: Full verification gate**

Run: `pnpm tc` and `pnpm test src/shared/goals/ src/main/goals/ src/cli/specs/goals.test.ts src/renderer/src/components/goals/`
Expected: All typechecks and tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/goals/ src/renderer/src/components/TerminalSurface.tsx
git commit -m "feat(renderer): add DockedGoalBar and mount into terminal surface"
```
