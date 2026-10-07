# Design Spec: Antigravity Multi-Account Project Default Profile Binding

**Date:** 2026-10-06  
**Status:** Approved  
**Author:** Pair Programming Session (Geko & Antigravity)  

---

## 1. Overview & Goals

Orca provides a robust multi-account system for Antigravity, including native encrypted vault storage, account metadata (aliases, colors, emojis), tab-level account badges (`launchAccountId`), and a persistent quota switcher menu in the status bar.

Currently, account selection is either global (ambient OS credential) or manually chosen per-tab via the Quick Launch submenu. When developers switch between different projects (for instance, a corporate enterprise repository versus a personal open-source project), they must remember to manually select the correct account every time they open a tab, spawn an automation, or invoke an agent. Forgetting to do so results in consuming quota on the wrong account, leaking identity context, or hitting unexpected rate limits.

This specification introduces the **Project Default Account Profile** feature:
1. **Per-Project Account Binding:** Each Project (`Repo`) can bind a default Antigravity account profile (`antigravityAccountId`), persisted across sessions in the repository settings.
2. **Project Settings UI (`RepositoryAntigravityAccountSection`):** An intuitive selector in `RepositoryPane` allowing users to bind an account profile with visual cues (alias, color dot, email, and live/snapshot quota state) or inherit the ambient global account.
3. **Automatic Launch Resolution:** When launching an Antigravity session, terminal tab, or automation within a project workspace without an explicit account override, Orca automatically resolves and binds the project's default account.
4. **Context Alignment in Status Bar:** The status bar and `AntigravitySwitcherMenu` detect when the globally active account differs from the focused project's default profile, providing clear visual alignment cues and a 1-click "Switch to Project Default" action.

---

## 2. Architecture & Data Model

### 2.1 Repository Data Model (`src/shared/repo-types.ts`)

Extend `Repo` to include an optional `antigravityAccountId`:

```ts
export type Repo = {
  // ... existing properties
  /**
   * Per-project default Antigravity account binding.
   * When set, new Antigravity sessions launched in this project inherit this account ID.
   * If null or undefined, inherits ambient active account.
   */
  antigravityAccountId?: string | null
}
```

### 2.2 Schema & RPC Validation (`src/shared/rpc-contract/repo-update-params.ts`)

Update `createRepoUpdateSchema` to validate and normalize `antigravityAccountId`:

```ts
updates: z.object({
  // ... existing fields
  antigravityAccountId: OptionalString.nullable().optional(),
})
```

- String values are trimmed; empty strings are coerced to `null`.
- `null` explicitly unsets the binding, reverting to ambient inheritance.

### 2.3 Sanitization and Storage (`src/main/persistence/tracking-repos/`)

- `repo-sanitization.ts`: Clean and sanitize `antigravityAccountId`. If falsy or empty, strip the field or set to `undefined`.
- `repo-update-operations.ts`: Handle updates to `antigravityAccountId`. If `null`, delete `repo.antigravityAccountId` from the persisted record.
- `src/renderer/src/store/repos/repo-update.ts`: Mirror the sanitization logic in the renderer-side store updater so the local optimistic state remains authoritative.

---

## 3. UI Presentation & Project Settings

### 3.1 Project Settings Section: `RepositoryAntigravityAccountSection.tsx`

Located at `src/renderer/src/components/settings/RepositoryAntigravityAccountSection.tsx`, rendered inside `RepositoryPane.tsx`:

- **Layout & Token Adherence:** Conforms to `STYLEGUIDE.md` and mirrors the established pattern of `RepositoryGitHubAccountSection.tsx`.
- **Account Selection Dropdown:**
  - Option 1 (Default): *"Ambient active account"* (`__ambient__`), displaying whichever account is globally selected.
  - Options 2..N: All registered Antigravity accounts retrieved via `useAntigravityAccounts()`.
  - Each item displays:
    - Colored dot / avatar (`account.color` or default blue).
    - Friendly alias (`account.alias`) or truncated email.
    - Full email in secondary typography (`text-muted-foreground`).
    - Quota summary indicator (e.g., Weekly / 5H remaining).
- **Missing Account Graceful State:** If a repository has an `antigravityAccountId` set to an ID that does not exist in the current host's vault (e.g., deleted account or cross-machine repo clone), the select surfaces an amber warning badge: *"Bound account not found on this machine"* and offers a 1-click button to reset or rebind.
- **Search Integration:** Registered in `repository-search.ts` with keywords: `antigravity`, `account`, `profile`, `quota`, `perfil`, `cuenta`.

---

## 4. Session & Execution Resolution

### 4.1 Launch Resolution (`src/renderer/src/lib/launch-agent-in-new-tab.ts`)

When `launchAgentInNewTab` is invoked for `agent: 'antigravity'`:
1. If `launchAccountId` is already specified by the caller (e.g., user picked a specific account from `QuickLaunchButton`'s submenu or an automation draft specifies one), that explicit ID takes precedence.
2. If `launchAccountId` is omitted:
   - Identify the repository corresponding to `worktreeId` via `findRepoByWorktreeId(worktreeId)`.
   - If `repo.antigravityAccountId` is defined and valid in `accounts`, set `launchAccountId = repo.antigravityAccountId`.
   - Otherwise, fall back to the ambient active account (`activeAccount?.id`).
3. Pass the resolved `launchAccountId` to `createTab` and terminal session creation, ensuring that:
   - The tab displays the project's account color dot and alias badge (`AntigravityAccountTabBadge`).
   - Terminal rate-limit failover operates within the expected identity scope.

### 4.2 Automation Integration (`src/renderer/src/components/automations/`)

When drafting or editing a new automation for a project in `AutomationEditorDialog`:
- The default `launchAccountId` automatically initializes to `repo.antigravityAccountId` if present.

---

## 5. Status Bar Alignment & Quick Switch

### 5.1 Project-Account Context Awareness

In `AntigravitySwitcherMenu.tsx` and `TokenUsageStatusSegment.tsx`:
- Compute `isProjectDefaultMisaligned`: true when the active workspace's repo has an `antigravityAccountId`, but `currentAccount?.id !== repo.antigravityAccountId`.
- When misaligned, render a subtle indicator chip in the switcher menu:
  - Header badge: *"Project Default: [Alias]"*
  - Quick action: *"Switch active credential to [Alias]"* allowing users to align the OS credential with the focused project with 1 click.

---

## 6. Internationalization (i18n) & Cross-Platform

- All user-facing strings are wrapped with `translate(...)` and keyed under `auto.components.settings.repository.*`.
- Default translations provided for English (`en.json`) and Spanish (`es.json`).
- Compatible with macOS, Linux, and Windows; accounts are scoped by runtime host (`RuntimeClientTarget`), preventing cross-host credential leaks.
