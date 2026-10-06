# Antigravity Multi-Account Project Default Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement per-project default Antigravity account profile binding in Orca, allowing users to configure, persist, and automatically inherit a project-specific account profile when launching sessions or working in that repository.

**Architecture:** Extend `Repo` with `antigravityAccountId` across shared types, RPC validation, and repository persistence. Build `RepositoryAntigravityAccountSection` in Project Settings (mirroring `RepositoryGitHubAccountSection`) with visual badges, quota summaries, and missing-account fallbacks. Update `launchAgentInNewTab` to automatically resolve the project's default account if not explicitly passed, and add alignment cues in `AntigravitySwitcherMenu`.

**Tech Stack:** TypeScript, React, Zustand, Tailwind CSS, Radix UI primitives, Zod, Vitest, Testing Library.

**Spec:** [`docs/superpowers/specs/2026-10-06-antigravity-project-default-account-profile-design.md`](file:///C:/Users/Geko/orca/workspaces/orca-upstream/siren/docs/superpowers/specs/2026-10-06-antigravity-project-default-account-profile-design.md)

## Global Constraints

- Never add `max-lines` disable comments or per-file bumps in `.oxlintrc.json`.
- Adhere strictly to [`docs/STYLEGUIDE.md`](file:///C:/Users/Geko/orca/workspaces/orca-upstream/siren/docs/STYLEGUIDE.md): reuse tokens, no raw palette colors, use shadcn primitives.
- Avoid type assertions except `as const`. Any unavoidable assertion requires an inline `SAFETY:` explanation.
- Keep all platform-specific checks behind runtime guards (`process.platform === 'win32'`).
- Always respect the repo's execution host (`getRepoExecutionHostId(repo)`) when resolving accounts.
- Do not spawn direct child processes; use Orca's RPC client and internal store APIs.

## Review Focus

1. **Vault / Account Deletion Resilience:** If an account bound to a project is deleted from the vault or missing on a different host, the UI must display a non-crashing warning banner/badge and gracefully fall back to the ambient account.
2. **Explicit Override Priority:** When launching from a specific account in the `QuickLaunchButton` dropdown, the explicit user selection must take precedence over the project's default account.
3. **Empty / Null Sentinel Normalization:** Clearing a project default (`null` or `""`) must correctly remove `antigravityAccountId` from disk rather than persisting a dangling empty string.
4. **Optimistic Store Sync:** Updating `antigravityAccountId` in settings must optimistically reflect in the active workspace and tab bar without requiring an app reload.
5. **Multi-Host Isolation:** A project configured with an account on a remote SSH host must query accounts using the remote runtime target, never confusing client Keychain items with remote authority.

---

### Task 1: Data Model, Schema Validation & Repository Persistence

**Files:**
- Modify: `src/shared/repo-types.ts`
- Modify: `src/shared/rpc-contract/repo-update-params.ts`
- Modify: `src/main/persistence/tracking-repos/repo-sanitization.ts`
- Modify: `src/main/persistence/tracking-repos/repo-update-operations.ts`
- Modify: `src/renderer/src/store/repos/repo-update.ts`
- Test: `src/main/runtime/rpc/methods/repo.test.ts`
- Test: `src/renderer/src/store/repos/repo-update.test.ts` (or appropriate repo store unit tests)

**Interfaces:**
- Consumes: `createRepoUpdateSchema`
- Produces:
  - `antigravityAccountId?: string | null` in `Repo` and `repo.update` RPC params.
  - Automatic normalization: string trimmed, empty string to `undefined`, `null` removes the property.

- [x] **Step 1: Write failing tests in `repo.test.ts` and `repo-update.test.ts`**
  Assert that:
  1. `repo.update` accepts `{ updates: { antigravityAccountId: 'acc-123' } }` and persists it on the repo.
  2. `repo.update` with `{ updates: { antigravityAccountId: null } }` removes `antigravityAccountId` from the repo record.
  3. Sanitization cleans whitespace and coerces empty strings to `undefined`.

- [x] **Step 2: Run tests to verify they fail**
  `pnpm test src/main/runtime/rpc/methods/repo.test.ts`

- [x] **Step 3: Implement data model and persistence updates**
  1. Add `antigravityAccountId?: string | null` to `Repo` in `src/shared/repo-types.ts`.
  2. Add `antigravityAccountId: OptionalString.nullable().optional()` in `src/shared/rpc-contract/repo-update-params.ts`.
  3. In `repo-sanitization.ts`, normalize `antigravityAccountId`.
  4. In `repo-update-operations.ts` and `src/renderer/src/store/repos/repo-update.ts`, handle adding/removing `antigravityAccountId`.

- [x] **Step 4: Run tests and verify they pass**
  `pnpm test src/main/runtime/rpc/methods/repo.test.ts`

- [x] **Step 5: Commit**
  `git commit -m "feat(repo): add antigravityAccountId to repository data model and persistence"`

---

### Task 2: Project Settings UI Section (`RepositoryAntigravityAccountSection`)

**Files:**
- Create: `src/renderer/src/components/settings/RepositoryAntigravityAccountSection.tsx`
- Create: `src/renderer/src/components/settings/RepositoryAntigravityAccountSection.test.tsx`
- Modify: `src/renderer/src/components/settings/RepositoryPane.tsx`
- Modify: `src/renderer/src/components/settings/repository-search.ts`

**Interfaces:**
- Props:
  ```ts
  type RepositoryAntigravityAccountSectionProps = {
    repo: Repo
    updateRepo: (repoId: string, updates: { antigravityAccountId?: string | null }) => unknown
    forceVisible?: boolean
  }
  ```
- Uses: `useAntigravityAccounts()`, `SearchableSetting`, `Select`, `SelectTrigger`, `SelectContent`, `SelectItem`.

- [x] **Step 1: Write failing tests in `RepositoryAntigravityAccountSection.test.tsx`**
  Assert that:
  1. Renders the section with title *"Default Antigravity Account"*.
  2. Displays *"Ambient active account"* as selected when `repo.antigravityAccountId` is undefined.
  3. Lists all accounts from `useAntigravityAccounts()` with their alias, color badge, and email.
  4. Selecting an account triggers `updateRepo(repo.id, { antigravityAccountId: 'selected-id' })`.
  5. Selecting ambient triggers `updateRepo(repo.id, { antigravityAccountId: null })`.
  6. Displays an alert/warning if `repo.antigravityAccountId` points to an ID not in the account list.

- [x] **Step 2: Run tests to verify they fail**
  `pnpm test src/renderer/src/components/settings/RepositoryAntigravityAccountSection.test.tsx`

- [x] **Step 3: Implement `RepositoryAntigravityAccountSection.tsx` and mount in `RepositoryPane.tsx`**
  1. Implement the component with full design system adherence and translation tokens.
  2. Add it to `RepositoryPane.tsx` adjacent to `RepositoryGitHubAccountSection`.
  3. Register search keywords in `repository-search.ts`.

- [x] **Step 4: Run tests and verify they pass**
  `pnpm test src/renderer/src/components/settings/RepositoryAntigravityAccountSection.test.tsx`

- [x] **Step 5: Commit**
  `git commit -m "feat(settings): add RepositoryAntigravityAccountSection for default profile selection"`

---

### Task 3: Automatic Account Resolution on Session / Tab Launch

**Files:**
- Modify: `src/renderer/src/lib/launch-agent-in-new-tab.ts`
- Modify: `src/renderer/src/lib/launch-agent-in-new-tab.test.ts`
- Modify: `src/renderer/src/components/tab-bar/QuickLaunchButton.tsx`
- Modify: `src/renderer/src/components/automations/automation-edit-draft.ts`

**Interfaces:**
- `launchAgentInNewTab(args: LaunchAgentInNewTabArgs)`:
  - If `args.agent === 'antigravity'` and `!args.launchAccountId`:
    - Lookup `repo` via `worktreeId`.
    - If `repo?.antigravityAccountId` exists, set `resolvedLaunchAccountId = repo.antigravityAccountId`.
    - Use `resolvedLaunchAccountId` for tab creation and session spawning.

- [x] **Step 1: Write failing tests in `launch-agent-in-new-tab.test.ts`**
  Assert that:
  1. Launching `antigravity` in a worktree whose repo has `antigravityAccountId: 'acc-work'` without explicit `launchAccountId` resolves to `'acc-work'`.
  2. If the caller explicitly provides `launchAccountId: 'acc-personal'`, it overrides the project's default.
  3. If the project has no `antigravityAccountId`, `launchAccountId` falls back to undefined (ambient).

- [x] **Step 2: Run tests to verify they fail**
  `pnpm test src/renderer/src/lib/launch-agent-in-new-tab.test.ts`

- [x] **Step 3: Implement resolution logic in `launch-agent-in-new-tab.ts`**
  Add helper `resolveDefaultLaunchAccountIdForWorktree(agent, worktreeId, explicitAccountId)`.

- [x] **Step 4: Run tests and verify they pass**
  `pnpm test src/renderer/src/lib/launch-agent-in-new-tab.test.ts`

- [x] **Step 5: Commit**
  `git commit -m "feat(launch): resolve project default account for antigravity sessions"`

---

### Task 4: Status Bar Alignment Indicator & Quick-Switch Action

**Files:**
- Modify: `src/renderer/src/components/status-bar/AntigravitySwitcherMenu.tsx`
- Modify: `src/renderer/src/components/status-bar/AntigravitySwitcherMenu.test.tsx`

**Interfaces:**
- Inspects `activeWorkspaceRepo?.antigravityAccountId`.
- When set and `currentAccount?.id !== activeWorkspaceRepo.antigravityAccountId`:
  - Surfaces a banner/chip: *"Project default: [Alias]"*.
  - Provides a 1-click button: *"Switch active to project default"*.

- [ ] **Step 1: Write failing tests in `AntigravitySwitcherMenu.test.tsx`**
  Assert that:
  1. If active repo has a default account and global active account differs, the menu shows the alignment suggestion.
  2. Clicking "Switch to project default" calls `selectAccount(repo.antigravityAccountId)`.

- [ ] **Step 2: Run tests to verify they fail**
  `pnpm test src/renderer/src/components/status-bar/AntigravitySwitcherMenu.test.tsx`

- [ ] **Step 3: Implement alignment chip and switch action in `AntigravitySwitcherMenu.tsx`**

- [ ] **Step 4: Run tests and verify they pass**
  `pnpm test src/renderer/src/components/status-bar/AntigravitySwitcherMenu.test.tsx`

- [ ] **Step 5: Commit**
  `git commit -m "feat(status-bar): show project default account alignment in AntigravitySwitcherMenu"`

---

### Task 5: Localization (i18n) & End-to-End Typecheck

**Files:**
- Modify: `src/renderer/src/i18n/locales/en.json`
- Modify: `src/renderer/src/i18n/locales/es.json`

- [ ] **Step 1: Add localization keys**
  Provide keys for:
  - `auto.components.settings.repository.antigravityAccount.title`: "Default Antigravity Account" / "Perfil de Antigravity predeterminado"
  - `auto.components.settings.repository.antigravityAccount.description`: "Account profile used when launching Antigravity sessions in this project." / "Perfil de cuenta utilizado al iniciar sesiones de Antigravity en este proyecto."
  - `auto.components.settings.repository.antigravityAccount.ambient`: "Ambient active account" / "Heredar cuenta activa global"
  - `auto.components.settings.repository.antigravityAccount.notFound`: "Configured account not found on this machine" / "La cuenta configurada no se encuentra en esta máquina"
  - `auto.components.settings.repository.antigravityAccount.switchToDefault`: "Switch to project default" / "Cambiar al predeterminado del proyecto"

- [ ] **Step 2: Run verification checks**
  1. `pnpm tc`
  2. `pnpm run check:code-quality:changed`
  3. `pnpm test`

- [ ] **Step 3: Commit**
  `git commit -m "chore(i18n): add translations for project default account settings"`
