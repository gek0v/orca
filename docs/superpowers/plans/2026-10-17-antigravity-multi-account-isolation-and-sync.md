# Antigravity Multi-Account Process Isolation, Unified Conversations & Reactive Quota Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate Antigravity session account overwrites on restart, unfreeze and synchronize the status-bar account badge and quota with active unified tabs/panes, and measure fresh quota reactively across all configured accounts while maintaining 100% unified conversations.

**Architecture:** 
1. `AntigravityProfileManager`: Creates account-scoped profile directories under `~/.gemini/profiles/<id>/.gemini/antigravity-cli/` enclosing canonical `conversations/`, `conversation_summaries.db`, `history.jsonl`, `brain/`, `skills/`, and `mcp/` via NTFS junctions (Windows) and POSIX symlinks (macOS/Linux), storing only `antigravity-oauth-token` per account.
2. PTY Launch Pipeline: Injects account-isolated profile environments during `prepareAntigravityAccountForLaunch` so concurrent tab spawns run in parallel without mutating the OS-wide keyring slot (`gemini:antigravity`).
3. Multi-Account Background Prober: Queries `agy -p /usage` against each account's isolated token file in parallel/bounded background cycles, durably records `lastUsage` in the vault, and pushes reactive IPC events (`antigravity-accounts-changed`) to renderer windows.
4. Active Account Resolution & Status Bar: Fixes `useActiveWindowAntigravityAccount` to resolve focused split panes (`s.activePaneId`) and unified tabs (`s.unifiedTabsByWorktree` / `s.getTab()`), updating badge and quota meters reactively without freezing.

**Tech Stack:** TypeScript, Node.js (`fs`, `path`, `os`), Electron IPC, Zustand (`useAppStore`), React, Vitest.

**Spec:** [`docs/superpowers/specs/2026-10-17-antigravity-multi-account-isolation-and-sync-design.md`](file:///D:/Workspaces/orca-upstream/docs/superpowers/specs/2026-10-17-antigravity-multi-account-isolation-and-sync-design.md)

## Global Constraints

- Target platforms: Windows (win32), macOS (darwin), Linux (linux). Cross-platform checks must gate all platform-specific logic behind runtime platform checks (`process.platform === 'win32'`).
- Directory junctions: On Windows, use `fs.symlinkSync(target, linkPath, 'junction')` for directories (no administrator privileges required). On POSIX, use `'dir'` and `'file'`.
- Canonical data protection: Never delete or mutate canonical `~/.gemini/antigravity-cli/` contents when pruning or unlinking an account profile.
- Code quality & line limits: Strictly obey repository style guidelines. No `max-lines` disable comments, no `as any`, format with `pnpm format`.
- Zero console flashing on Windows: Child processes spawned for probes must preserve `windowsHide: true`.

## Review Focus

1. **Concurrent PTY cold restart race:** Two or more tabs launching at the exact same millisecond with different `launchAccountId`s must both receive their own independent profile environments without overwriting `gemini:antigravity`.
2. **Account deletion resilience:** A restored tab whose `launchAccountId` was removed from the vault must gracefully fall back to the default account without crashing PTY spawn or breaking shell initialization.
3. **Canonical conversation link integrity:** Writing or summarizing a conversation inside a profile PTY must immediately be visible in the canonical directory `~/.gemini/antigravity-cli/conversations` and `conversation_summaries.db`.
4. **Token revocation during background probe:** An account whose token was revoked must produce an `auth-expired` / `signed-out` classification and transition to `unavailable` rather than causing an unhandled rejection or spinning in an infinite retry loop.
5. **Split pane focus transitions:** Switching focus between two split terminal panes in the same window (one running Antigravity Account A, one running Account B) must instantly switch the status bar badge and quota without lag or state locking.

---

### Task 1: `AntigravityProfileManager` for Transparent Profile Enclosure

**Files:**
- Create: `src/main/antigravity/native-account-profile-manager.ts`
- Create: `src/main/antigravity/native-account-profile-manager.test.ts`

**Interfaces:**
- Consumes: `AntigravityAccountSummary`, `AntigravityNativeCredential`
- Produces: 
  ```ts
  export interface AntigravityProfileInfo {
    profileDir: string
    cliDir: string
    tokenPath: string
    envPatch: NodeJS.ProcessEnv
  }

  export function getAntigravityProfileBaseDir(homeDir?: string): string
  export function ensureAntigravityAccountProfile(accountId: string, credentialsJson: string, options?: { homeDir?: string }): AntigravityProfileInfo
  export function removeAntigravityAccountProfile(accountId: string, options?: { homeDir?: string }): void
  ```

- [ ] **Step 1: Write failing unit tests for profile directory and junction management**

In `src/main/antigravity/native-account-profile-manager.test.ts`, assert:
1. `ensureAntigravityAccountProfile` creates `~/.gemini/profiles/<id>/.gemini/antigravity-cli/` idempotently.
2. Creates junctions/symlinks to canonical `conversations/`, `brain/`, `skills/`, `mcp/`, `conversation_summaries.db`, `history.jsonl`.
3. Writes `credentialsJson` into `antigravity-oauth-token` atomically with permissions 0o600 / safe permissions.
4. `removeAntigravityAccountProfile` unlinks junctions and removes profile directory without touching canonical target directory contents.
5. Review Focus #3: Appending a file inside `profile/conversations/` writes directly into canonical `conversations/`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/antigravity/native-account-profile-manager.test.ts`  
Expected: FAIL with missing module.

- [ ] **Step 3: Implement `AntigravityProfileManager` in `native-account-profile-manager.ts`**

Implement idempotent directory creation, NTFS junctions on `win32` / symlinks on POSIX, atomic token writing using `writeCredentialFileAtomic`, and safe unlinking.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/main/antigravity/native-account-profile-manager.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/antigravity/native-account-profile-manager.ts src/main/antigravity/native-account-profile-manager.test.ts
git commit -m "feat(antigravity): add profile manager with transparent canonical junctions"
```

---

### Task 2: PTY Launch Pipeline & Concurrency Race Elimination

**Files:**
- Modify: `src/main/antigravity/native-account-launch.ts`
- Modify: `src/main/antigravity/native-account-launch.test.ts`
- Modify: `src/main/ipc/pty/ipc/spawn-env.ts`

**Interfaces:**
- Consumes: `ensureAntigravityAccountProfile` from Task 1, `assemblePtyIpcSpawnEnv`
- Produces: Concurrency-safe `prepareAntigravityAccountForLaunch` with profile environment injection into PTY spawn args.

- [ ] **Step 1: Write failing unit tests for concurrent launch and deletion fallback**

In `src/main/antigravity/native-account-launch.test.ts`:
1. Review Focus #1: Two parallel calls to `prepareAntigravityAccountForLaunch` with `launchAccountId: 'acc-1'` and `launchAccountId: 'acc-2'` must configure independent profile paths without modifying the global OS keyring `gemini:antigravity`.
2. Review Focus #2: If `launchAccountId` is missing from the vault, safely fall back to `vault.selectedAccountId` or default without throwing errors.
3. Verify `spawnEnv` receives the account's file-storage credential authority.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/antigravity/native-account-launch.test.ts`  
Expected: FAIL due to existing `selectAccount()` call mutating global keyring.

- [ ] **Step 3: Update `prepareAntigravityAccountForLaunch` to use profile isolation**

Update `native-account-launch.ts` to call `ensureAntigravityAccountProfile` when `launchAccountId` is present, inject the profile environment variables into `args.env`, and remove the global `selectAccount()` call on PTY launch.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/main/antigravity/native-account-launch.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/antigravity/native-account-launch.ts src/main/antigravity/native-account-launch.test.ts src/main/ipc/pty/ipc/spawn-env.ts
git commit -m "fix(antigravity): isolate pty spawn environments to prevent restart account collisions"
```

---

### Task 3: Multi-Account Rate-Limit Background Prober & IPC Broadcast

**Files:**
- Modify: `src/main/rate-limits/antigravity-usage-fetcher.ts`
- Modify: `src/main/rate-limits/antigravity-usage-fetcher.test.ts`
- Modify: `src/main/rate-limits/service/service-full-cycle-application.ts`
- Modify: `src/main/rate-limits/service-antigravity-usage.test.ts`
- Modify: `src/main/antigravity/native-account-service.ts`

**Interfaces:**
- Consumes: `AntigravityProfileInfo`, `fetchAntigravityRateLimits`, `recordUsageSnapshot`
- Produces:
  ```ts
  export function fetchAntigravityAccountRateLimits(options: FetchAntigravityRateLimitsOptions & {
    accountId: string
    credentialsJson?: string
  }): Promise<ProviderRateLimits>
  ```

- [ ] **Step 1: Write failing unit tests for per-account rate limit probing & broadcast**

In `src/main/rate-limits/antigravity-usage-fetcher.test.ts` and `service-antigravity-usage.test.ts`:
1. Assert `fetchAntigravityAccountRateLimits` targets the account's isolated token file.
2. Review Focus #4: Revoked/invalid token returns `status: 'unavailable'` with `failureKind: 'auth-expired'`.
3. In `service-full-cycle-application.ts`: verify background rate-limit refresh iterates over all configured vault accounts and saves snapshots via `recordUsageSnapshot`.
4. Verify IPC event `antigravity-accounts-changed` is emitted on snapshot updates.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/rate-limits/service-antigravity-usage.test.ts`  
Expected: FAIL because multi-account polling and IPC push are not yet wired.

- [ ] **Step 3: Implement `fetchAntigravityAccountRateLimits` and multi-account polling**

1. In `antigravity-usage-fetcher.ts`, implement account-scoped probe execution.
2. In `service-full-cycle-application.ts`, query each vault account in bounded parallel batches and persist snapshots.
3. In `native-account-service.ts` / main window controller, dispatch `antigravity-accounts-changed` IPC notification.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/main/rate-limits/service-antigravity-usage.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/rate-limits/antigravity-usage-fetcher.ts src/main/rate-limits/antigravity-usage-fetcher.test.ts src/main/rate-limits/service/service-full-cycle-application.ts src/main/antigravity/native-account-service.ts
git commit -m "feat(antigravity): probe rate limits for all accounts and broadcast updates via IPC"
```

---

### Task 4: Reactive Renderer State & Active Tab Resolution Hierarchy

**Files:**
- Modify: `src/renderer/src/hooks/useAntigravityAccounts.ts`
- Create: `src/renderer/src/hooks/useAntigravityAccounts.test.ts`
- Modify: `src/renderer/src/components/status-bar/StatusBarProviderSegment.tsx`
- Modify: `src/renderer/src/components/status-bar/StatusBarProviderSegment.test.tsx`

**Interfaces:**
- Consumes: `unifiedTabsByWorktree`, `activePaneId`, `activeTabId`, `antigravity-accounts-changed` IPC event.
- Produces: Fixed `useActiveWindowAntigravityAccount()` and reactive `useAntigravityAccounts()`.

- [ ] **Step 1: Write failing unit tests for unified tabs and split pane account resolution**

In `src/renderer/src/hooks/useAntigravityAccounts.test.ts`:
1. When `s.activeTabId` matches a unified tab in `s.unifiedTabsByWorktree` with `launchAgent: 'antigravity'` and `launchAccountId: 'acc-2'`, returns account summary for `acc-2`.
2. Review Focus #5: When `s.activePaneId` matches a focused split pane terminal leaf with `launchAccountId: 'acc-3'`, returns `acc-3` immediately.
3. Falls back to worktree repo binding and global active account if active tab is non-Antigravity.
4. Updates dynamically when IPC event `antigravity-accounts-changed` fires.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/renderer/src/hooks/useAntigravityAccounts.test.ts`  
Expected: FAIL because `useActiveWindowAntigravityAccount` only looks at legacy `tabsByWorktree`.

- [ ] **Step 3: Implement unified resolution hierarchy and IPC event subscription**

1. In `useAntigravityAccounts.ts`, subscribe to IPC notification `antigravity-accounts-changed` and update `cachedState`.
2. Rewrite `useActiveWindowAntigravityAccount` to follow the 4-tier hierarchy:
   - Tier 1: Focused split pane (`s.activePaneId`)
   - Tier 2: Active unified tab (`s.getTab()` / `s.unifiedTabsByWorktree`)
   - Tier 3: Legacy tabs (`s.tabsByWorktree`)
   - Tier 4: Repo binding / global default
3. In `StatusBarProviderSegment.tsx`, ensure `displayedAccount.lastUsage` renders reactively without freezing.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/renderer/src/hooks/useAntigravityAccounts.test.ts src/renderer/src/components/status-bar/StatusBarProviderSegment.test.tsx`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/hooks/useAntigravityAccounts.ts src/renderer/src/hooks/useAntigravityAccounts.test.ts src/renderer/src/components/status-bar/StatusBarProviderSegment.tsx
git commit -m "fix(antigravity): resolve active account from unified tabs and split panes with reactive quota sync"
```

---

### Task 5: Integration Verification & Regression Gate

**Files:**
- Test: All affected test suites across main and renderer.

- [ ] **Step 1: Run typechecks**

Run: `pnpm tc`  
Expected: Clean compilation across node, cli, and web targets.

- [ ] **Step 2: Run changed code quality and lint checks**

Run: `pnpm run check:code-quality:changed`  
Expected: Clean linting, no styleguide or design system violations, no `max-lines` ratchet violations.

- [ ] **Step 3: Run full Antigravity test suite**

Run: `pnpm test src/main/antigravity/ src/main/rate-limits/ src/renderer/src/hooks/useAntigravityAccounts.test.ts`  
Expected: All tests PASS.

- [ ] **Step 4: Commit and finalize**

```bash
git commit --allow-empty -m "chore(antigravity): complete multi-account isolation and sync verification"
```
