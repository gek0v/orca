# Antigravity In-App Quota Recovery Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement an intelligent, in-app quota recovery monitor for Antigravity accounts in Orca that tracks recovery timestamps (`resetsAt`), fires interactive Sonner toasts with a 1-click switch action when the active account is strained, and displays "Ready" badges in the switcher menu.

**Architecture:** A lightweight client-side React hook (`useAntigravityQuotaResetMonitor`) subscribes to `useAntigravityAccounts` and rate-limit states. When an inactive account reaches its reset timestamp while the active account has high or exhausted usage (`>=80%`), it fires a Sonner toast with a direct `[Switch]` action button that invokes `switchAntigravityAccountAndRestartSession`. `AntigravitySwitcherMenu` consumes the monitor and marks ready accounts with a clean "Ready" badge.

**Tech Stack:** React 19, TypeScript, Vitest, Sonner (`toast`), Tailwind CSS tokens (`STYLEGUIDE.md`).

**Spec:** [docs/superpowers/specs/2026-10-14-antigravity-quota-recovery-monitor-design.md](file:///C:/Users/Geko/orca/projects/orca-upstream/docs/superpowers/specs/2026-10-14-antigravity-quota-recovery-monitor-design.md)

## Global Constraints

- Never dispatch OS desktop notifications via `window.api.notifications.dispatch`; all alerts must be strictly in-app (`toast` from `sonner`).
- No modifications to the native OS keyring or vault storage during recovery polling; candidate tracking is entirely in-memory and driven by existing snapshots.
- UI components must strictly adhere to `STYLEGUIDE.md` and `RULE[AGENTS.md]` (tokens from `main.css`, no arbitrary Tailwind raw colors).
- Tests must pass cleanly with `pnpm test` and typecheck with `pnpm tc`.

## Review Focus

1. **System sleep / wake-up batching:** When machine sleeps for hours and multiple accounts expire simultaneously, ensure only one toast is fired for the top candidate rather than spamming multiple toasts.
2. **Healthy active account silence:** Ensure no toast is triggered if the currently active account has ample quota (`<80%`), keeping the user focused.
3. **Deduplication:** Ensure the exact same `(accountId, resetsAt)` pair cannot fire more than once across re-renders or component unmount/remounts.
4. **Invalid or null timestamp handling:** Accounts with `resetsAt === null`, `NaN`, or negative values must not crash or trigger spurious timers.
5. **Switch action error safety:** If `switchAntigravityAccountAndRestartSession` rejects or the server returns an unexpected error, ensure the promise rejection is caught and toasted as an error rather than unhandled.

---

### Task 1: Core Monitor Hook (`useAntigravityQuotaResetMonitor`)

**Files:**
- Create: `src/renderer/src/hooks/useAntigravityQuotaResetMonitor.ts`
- Test: `src/renderer/src/hooks/useAntigravityQuotaResetMonitor.test.ts`

**Interfaces:**
- Consumes:
  - `useAntigravityAccounts`: `{ accounts: AntigravityAccountSummary[], activeAccount: AntigravityAccountSummary | null }`
  - `switchAntigravityAccountAndRestartSession({ targetAccountId: string, target: CodexStatusRuntimeTarget }): Promise<{ restarted: boolean }>`
  - `toast` from `'sonner'`
  - `useResetCountdownClock(timestamps: (number | null | undefined)[]): number`
- Produces:
  - `export function useAntigravityQuotaResetMonitor(options?: QuotaRecoveryMonitorOptions): { readyAccountIds: Set<string> }`
  - `export function isAccountStrained(limits: ProviderRateLimits | null | undefined, threshold?: number): boolean`
  - `export function findRecoveredCandidates(accounts: AntigravityAccountSummary[], activeAccountId: string | null | undefined, now: number): QuotaRecoveryCandidate[]`

- [ ] **Step 1: Write the failing unit tests for candidate detection, strained check, and toast dispatch**

Create `src/renderer/src/hooks/useAntigravityQuotaResetMonitor.test.ts` testing:
1. `isAccountStrained` returns true when `usedPercent >= 80` or `status === 'error'` or limits are null.
2. `isAccountStrained` returns false when `usedPercent < 80` and `status === 'ok'`.
3. Candidate detection identifies accounts with expired `resetsAt` that were previously high-usage.
4. Hook dispatches a single Sonner toast with `[Switch]` action button when active account is strained and inactive account reaches reset time.
5. Hook does NOT dispatch toast when active account is healthy (`usedPercent: 20`).
6. Hook deduplicates: does not fire twice for the same `(accountId, resetsAt)`.
7. Batch expiration (simulating wake-from-sleep): fires only one toast for the earliest reset account.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/renderer/src/hooks/useAntigravityQuotaResetMonitor.test.ts`  
Expected: FAIL (module `useAntigravityQuotaResetMonitor` not found)

- [ ] **Step 3: Implement `useAntigravityQuotaResetMonitor.ts`**

Implement in `src/renderer/src/hooks/useAntigravityQuotaResetMonitor.ts`:
- Pure helper functions `isAccountStrained(limits, threshold = 80): boolean`.
- Deduplication state using a ref `notifiedPairsRef = useRef<Set<string>>(new Set())`.
- Timer synchronization hook calling `useResetCountdownClock`.
- On expiry when strained: calls `toast.info` with action `{ label: 'Switch', onClick: () => switchAntigravityAccountAndRestartSession(...) }`.
- Return `{ readyAccountIds }` tracking accounts where `now >= resetsAt`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/renderer/src/hooks/useAntigravityQuotaResetMonitor.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/hooks/useAntigravityQuotaResetMonitor.ts src/renderer/src/hooks/useAntigravityQuotaResetMonitor.test.ts
git commit -m "feat(antigravity): add in-app quota recovery monitor hook"
```

---

### Task 2: Switcher Menu UI Integration (`AntigravitySwitcherMenu.tsx`)

**Files:**
- Modify: `src/renderer/src/components/status-bar/AntigravitySwitcherMenu.tsx`
- Modify: `src/renderer/src/components/status-bar/AntigravitySwitcherMenu.test.tsx`

**Interfaces:**
- Consumes:
  - `useAntigravityQuotaResetMonitor` from `@/hooks/useAntigravityQuotaResetMonitor`
- Produces:
  - Renders `"Ready"` badge (`bg-muted text-foreground text-[9px] font-medium rounded px-1 py-0.5`) on account rows matching `readyAccountIds`.
  - Integrates `useAntigravityQuotaResetMonitor({ activeTarget: selectedGroup?.runtimeTarget })` at the top of the menu component so the monitor runs while the status bar is rendered.

- [ ] **Step 1: Write the failing tests in `AntigravitySwitcherMenu.test.tsx`**

Add tests to `src/renderer/src/components/status-bar/AntigravitySwitcherMenu.test.tsx`:
1. Renders the "Ready" badge for accounts that have reached their reset timestamp or are marked in `readyAccountIds`.
2. Verifies clicking on a recovered account triggers the switch confirmation / session restart as usual.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/renderer/src/components/status-bar/AntigravitySwitcherMenu.test.tsx`  
Expected: FAIL (badge not rendered or monitor not wired)

- [ ] **Step 3: Update `AntigravitySwitcherMenu.tsx`**

In `src/renderer/src/components/status-bar/AntigravitySwitcherMenu.tsx`:
- Call `const { readyAccountIds } = useAntigravityQuotaResetMonitor({ activeTarget: selectedGroup?.runtimeTarget })`.
- In the account item loop, check `const isReady = readyAccountIds.has(account.id) || (account.lastUsage?.session?.usedPercent === 0 && !isCurrentAccount)`.
- If `isReady`, render the badge:
  ```tsx
  <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] font-medium text-foreground">
    {translate('auto.components.status.bar.StatusBar.ready', 'Ready')}
  </span>
  ```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/renderer/src/components/status-bar/AntigravitySwitcherMenu.test.tsx`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/status-bar/AntigravitySwitcherMenu.tsx src/renderer/src/components/status-bar/AntigravitySwitcherMenu.test.tsx
git commit -m "feat(antigravity): render ready badge and mount quota monitor in switcher menu"
```

---

### Task 3: Full Verification and Quality Gate

**Files:** None (verification step)

- [ ] **Step 1: Run complete Antigravity test suite**

Run:
```bash
pnpm test src/renderer/src/hooks/useAntigravityQuotaResetMonitor.test.ts src/renderer/src/components/status-bar/AntigravitySwitcherMenu.test.tsx src/renderer/src/hooks/useAntigravityAccounts.test.ts
```
Expected: All tests pass.

- [ ] **Step 2: Run typecheck**

Run: `pnpm tc`  
Expected: Clean exit code 0 without type errors.

- [ ] **Step 3: Run linting and code quality**

Run: `pnpm run check:code-quality:changed` or `oxlint`  
Expected: Zero lint or design system violations.
