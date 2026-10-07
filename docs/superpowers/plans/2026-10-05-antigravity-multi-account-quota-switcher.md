# Antigravity Multi-Account Quota Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement an interactive multi-account quota switcher menu for Antigravity in the status bar, displaying live and persistent rate-limit snapshots and reset countdowns for all configured accounts.

**Architecture:** Extend the encrypted vault store and account service with durable quota snapshots (`lastUsage`, `lastUsageAt`) captured automatically during rate-limit cycles. Create `AntigravitySwitcherMenu` (mirroring `ClaudeSwitcherMenu` and `CodexSwitcherMenu`) that renders inside the status-bar `UsageRosterPanel` via `renderRow`, displaying all registered accounts with their aliases, emojis, inline quota bars, and instant 1-click account switching.

**Tech Stack:** TypeScript, React, Tailwind CSS, Radix UI dropdown primitives, Node.js crypto/fs, Vitest, Testing Library.

**Spec:** [`docs/superpowers/specs/2026-10-05-antigravity-multi-account-quota-switcher-design.md`](file:///C:/Users/Geko/orca/projects/orca-upstream/docs/superpowers/specs/2026-10-05-antigravity-multi-account-quota-switcher-design.md)

## Global Constraints

- Never add `max-lines` disable comments or per-file bumps in `.oxlintrc.json`.
- Adhere strictly to [`docs/STYLEGUIDE.md`](file:///C:/Users/Geko/orca/projects/orca-upstream/docs/STYLEGUIDE.md): reuse existing tokens and primitives (`components/ui/dropdown-menu`, `InlineUsageBars`).
- Avoid type assertions except `as const`. Any unavoidable assertion requires an inline `SAFETY:` explanation.
- Keep all platform-specific checks behind runtime guards (`process.platform === 'win32'`).
- Do not spawn direct child processes; rate limit reads must route through existing `antigravity-usage-fetcher.ts`.

## Review Focus

1. Vault backward compatibility: existing vault files on disk lacking `lastUsage` must load without error or schema rejection.
2. Inactive account reset countdown accuracy: countdowns must be computed from `lastUsage.weekly.resetsAt` or session reset timestamps against current client time without drifting.
3. Race condition prevention during account switching: rapid switching in the menu must disable clicked rows and avoid clobbering simultaneous store writes.
4. Active account live priority: the active account must reflect the live `rateLimits.antigravity` store state over stale vault snapshots.
5. Clean rendering when an account has no prior usage snapshot (displaying graceful fallback copy rather than broken progress bars).

---

### Task 1: Extended Data Model, Vault Storage & Account Service Snapshot Recording

**Files:**
- Modify: `src/shared/antigravity-account-types.ts`
- Modify: `src/main/antigravity/native-account-store.ts`
- Modify: `src/main/antigravity/native-account-store.test.ts`
- Modify: `src/main/antigravity/native-account-service.ts`
- Modify: `src/main/antigravity/native-account-service.test.ts`

**Interfaces:**
- Consumes: `ProviderRateLimits` from `src/shared/rate-limit-types.ts`, `AntigravityAccountStore`
- Produces:
  - `AntigravityAccountSummary` with `lastUsage?: ProviderRateLimits | null` and `lastUsageAt?: number | null`
  - `StoredAntigravityAccount` with `lastUsage?: ProviderRateLimits | null` and `lastUsageAt?: number | null`
  - `updateAccountUsage(accountId: string, usage: ProviderRateLimits, timestamp: number): void` in `AntigravityAccountStore`
  - `recordUsageSnapshot(accountId: string, usage: ProviderRateLimits): Promise<AntigravityAccountState>` in `AntigravityAccountService`

- [x] **Step 1: Write failing tests in `native-account-store.test.ts` and `native-account-service.test.ts`**

In `src/main/antigravity/native-account-store.test.ts`, add test cases asserting:
1. `isAccount` validates accounts containing optional `lastUsage` and `lastUsageAt`.
2. `updateAccountUsage` updates `lastUsage` and `lastUsageAt` on the targeted account without altering credentials or `createdAt`.
3. An unknown `accountId` passed to `updateAccountUsage` is safely ignored without throwing.

In `src/main/antigravity/native-account-service.test.ts`, add test cases asserting:
1. `recordUsageSnapshot` persists usage and returns updated state where the account carries `lastUsage`.
2. Subsequent `listAccounts()` preserves the recorded `lastUsage` snapshots.

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/main/antigravity/native-account-store.test.ts src/main/antigravity/native-account-service.test.ts`
Expected: FAIL with missing methods `updateAccountUsage` and `recordUsageSnapshot`.

- [x] **Step 3: Implement data model and store updates**

In `src/shared/antigravity-account-types.ts`:
- Add `lastUsage?: ProviderRateLimits | null` and `lastUsageAt?: number | null` to `AntigravityAccountSummary`.

In `src/main/antigravity/native-account-store.ts`:
- Update `StoredAntigravityAccount` to include `lastUsage` and `lastUsageAt`.
- Update `isAccount` type guard to permit optional `lastUsage` object and `lastUsageAt` number.
- Add `updateAccountUsage(accountId: string, usage: ProviderRateLimits, timestamp: number): void` to `AntigravityAccountStore` interface and implementation.

In `src/main/antigravity/native-account-service.ts`:
- Implement `recordUsageSnapshot(accountId: string, usage: ProviderRateLimits): Promise<AntigravityAccountState>`.
- Ensure `state()` mapping passes through `lastUsage` and `lastUsageAt` to `AntigravityAccountSummary`.

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/main/antigravity/native-account-store.test.ts src/main/antigravity/native-account-service.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/shared/antigravity-account-types.ts src/main/antigravity/native-account-store.ts src/main/antigravity/native-account-store.test.ts src/main/antigravity/native-account-service.ts src/main/antigravity/native-account-service.test.ts
git commit -m "feat(antigravity): add persistent usage snapshot support to account store and service"
```

---

### Task 2: Automatic Snapshot Recording in Rate Limit Service

**Files:**
- Modify: `src/main/rate-limits/service/service-full-cycle-application.ts`
- Modify: `src/main/rate-limits/service-antigravity-usage.test.ts`
- Modify: `src/main/antigravity/native-account-host.ts`

**Interfaces:**
- Consumes: `antigravitySettled` in `RateLimitServiceFullCycleApplication`, `getAntigravityAccountService`
- Produces: Automatic call to `recordUsageSnapshot` on successful host quota reads

- [x] **Step 1: Write failing test in `service-antigravity-usage.test.ts`**

Add a test case asserting that when `fetchAntigravityRateLimits` resolves with an `ok` status containing rate limits:
1. `recordUsageSnapshot` on `AntigravityAccountService` is called with the active account ID and the settled `antigravity` rate limit reading.
2. If `antigravity` status is `unavailable` or `error`, `recordUsageSnapshot` is not called.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/rate-limits/service-antigravity-usage.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement snapshot recording in `service-full-cycle-application.ts`**

In `src/main/rate-limits/service/service-full-cycle-application.ts`:
- When settling `antigravitySettled`:
  ```ts
  if (antigravity.status === 'ok') {
    try {
      const accountService = getAntigravityAccountService({ runtime: 'host' })
      const state = await accountService.listAccounts()
      if (state.activeAccountId) {
        await accountService.recordUsageSnapshot(state.activeAccountId, antigravity)
      }
    } catch {
      // Non-fatal if account snapshot cannot be saved
    }
  }
  ```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm test src/main/rate-limits/service-antigravity-usage.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/main/rate-limits/service/service-full-cycle-application.ts src/main/rate-limits/service-antigravity-usage.test.ts
git commit -m "feat(rate-limits): record Antigravity usage snapshot on successful cycle"
```

---

### Task 3: Localization Strings for Antigravity Switcher Menu

**Files:**
- Modify: `src/renderer/src/i18n/locales/en.json`
- Modify: `src/renderer/src/i18n/locales/es.json`

**Interfaces:**
- Consumes: Standard translation keys
- Produces: Localization entries under `auto.components.status.bar.AntigravitySwitcherMenu`

- [x] **Step 1: Add translation keys in `en.json`**

Add:
```json
"auto.components.status.bar.AntigravitySwitcherMenu.title": "Antigravity Accounts",
"auto.components.status.bar.AntigravitySwitcherMenu.switchTo": "Switch to",
"auto.components.status.bar.AntigravitySwitcherMenu.active": "Active",
"auto.components.status.bar.AntigravitySwitcherMenu.noUsageData": "No usage data yet",
"auto.components.status.bar.AntigravitySwitcherMenu.clickToActivate": "Click to activate",
"auto.components.status.bar.AntigravitySwitcherMenu.manageAccounts": "Manage accounts...",
"auto.components.status.bar.AntigravitySwitcherMenu.openDetails": "Open Antigravity details and account switcher"
```

- [x] **Step 2: Add translation keys in `es.json`**

Add corresponding Spanish translations:
```json
"auto.components.status.bar.AntigravitySwitcherMenu.title": "Cuentas de Antigravity",
"auto.components.status.bar.AntigravitySwitcherMenu.switchTo": "Cambiar a",
"auto.components.status.bar.AntigravitySwitcherMenu.active": "Activa",
"auto.components.status.bar.AntigravitySwitcherMenu.noUsageData": "Sin datos de uso aún",
"auto.components.status.bar.AntigravitySwitcherMenu.clickToActivate": "Clic para activar",
"auto.components.status.bar.AntigravitySwitcherMenu.manageAccounts": "Administrar cuentas...",
"auto.components.status.bar.AntigravitySwitcherMenu.openDetails": "Abrir detalles y selector de cuentas de Antigravity"
```

- [x] **Step 3: Commit**

```bash
git add src/renderer/src/i18n/locales/en.json src/renderer/src/i18n/locales/es.json
git commit -m "i18n: add localization keys for Antigravity switcher menu"
```

---

### Task 4: `AntigravitySwitcherMenu` Component & Status Bar Integration

**Files:**
- Create: `src/renderer/src/components/status-bar/AntigravitySwitcherMenu.tsx`
- Create: `src/renderer/src/components/status-bar/AntigravitySwitcherMenu.test.tsx`
- Modify: `src/renderer/src/components/status-bar/StatusBarSurface.tsx`

**Interfaces:**
- Consumes:
  - `ProviderRateLimits`
  - `useAntigravityAccounts` from `@/hooks/useAntigravityAccounts`
  - `callAntigravityAccounts` from `@/runtime/runtime-antigravity-accounts-client`
  - `ProviderDetailsMenu`, `InlineUsageBars`
- Produces: `AntigravitySwitcherMenu` React component

- [x] **Step 1: Write unit tests in `AntigravitySwitcherMenu.test.tsx`**

Test scenarios:
1. Renders the active account with its alias, emoji/color, and "Active" badge.
2. Clicking the active account row expands the accounts list showing all registered accounts.
3. Renders `InlineUsageBars` for accounts with `lastUsage`.
4. Renders graceful fallback copy ("No usage data yet") for accounts without `lastUsage`.
5. Clicking an inactive account calls `callAntigravityAccounts` with `Select` action, disables the button during switching, and triggers rate-limit refresh.
6. Renders "Manage accounts..." button navigating to settings.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm test src/renderer/src/components/status-bar/AntigravitySwitcherMenu.test.tsx`
Expected: FAIL with module not found.

- [x] **Step 3: Implement `AntigravitySwitcherMenu.tsx`**

Create `src/renderer/src/components/status-bar/AntigravitySwitcherMenu.tsx`:
- Export `AntigravitySwitcherMenu({ antigravity, compact, iconOnly, asSubmenu, triggerContent })`.
- Utilize `useAntigravityAccounts()` to retrieve accounts list and active account.
- For the active account, merge in live `antigravity` prop data if `account.id === activeAccount.id`.
- For other accounts, use `account.lastUsage`.
- Use `InlineUsageBars` for rendering quota bars.
- Connect account click to `callAntigravityAccounts({ kind: 'local' }, { runtime: 'host' }, 'Select', { accountId })` and `refreshRateLimits()`.

In `src/renderer/src/components/status-bar/StatusBarSurface.tsx`:
- Import `AntigravitySwitcherMenu`.
- In `renderRow`, if `p.provider === 'antigravity'`, return `<AntigravitySwitcherMenu antigravity={p} compact={compact} iconOnly={false} asSubmenu triggerContent={rowNode} />`.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm test src/renderer/src/components/status-bar/AntigravitySwitcherMenu.test.tsx`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/renderer/src/components/status-bar/AntigravitySwitcherMenu.tsx src/renderer/src/components/status-bar/AntigravitySwitcherMenu.test.tsx src/renderer/src/components/status-bar/StatusBarSurface.tsx
git commit -m "feat(status-bar): implement AntigravitySwitcherMenu and integrate into status bar roster"
```

---

### Task 5: End-to-End Verification & Quality Gates

**Files:**
- Verification only

- [x] **Step 1: Run typechecks**

Run: `pnpm tc`
Expected: 0 errors across node, cli, and web.

- [x] **Step 2: Run all related tests**

Run: `pnpm test src/main/antigravity/ src/main/rate-limits/ src/renderer/src/components/status-bar/`
Expected: All tests pass.

- [x] **Step 3: Check code quality and formatting**

Run: `pnpm run check:code-quality:changed`
Expected: 0 lint errors, clean design system check.
