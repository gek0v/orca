# Design Spec: Antigravity In-App Quota Recovery Monitor & Interactive Switch Alerts

**Date:** 2026-10-14  
**Status:** Approved  
**Author:** Pair Programming Session (Geko & Antigravity)  

---

## 1. Overview & Goals

Orca provides native encrypted multi-account management for Antigravity, including per-account rate limit snapshots, tab-level account bindings, and a status-bar quota switcher menu.

Currently, when a developer exhausts their active Antigravity quota (e.g. 5-hour session window or weekly rate limits), discovering that a secondary or alternate account has recovered its quota requires manually opening the status-bar dropdown or waiting until an active operation fails. Furthermore, system-level OS notifications are intrusive and disconnect the developer from the editor workspace.

This specification introduces the **In-App Quota Recovery Monitor & Interactive Switch Alerts**:
1. **Intelligent In-App Alerts (Sonner Toasts):** When the active Antigravity account is constrained (`usedPercent >= 80%` or rate-limited) and another saved account reaches its recovery timestamp (`resetsAt`), an in-app interactive toast informs the user with a 1-click `[Switch]` action.
2. **Subtle Non-Intrusive Gating:** If the active account has sufficient available quota, the monitor avoids firing disruptive toasts and quietly updates the status bar switcher state.
3. **Recovery State & Countdown Indicators in Switcher Menu:** In `AntigravitySwitcherMenu`, accounts with pending resets show live tabular countdowns (`resetsAt`), and accounts with restored quota display a clean `"Ready"` / `"Available"` badge.
4. **Resilient Scheduling & Deduplication:** Handles system wake-from-sleep and clock drift gracefully, ensuring that accounts recovering simultaneously while the machine was asleep trigger at most one consolidated notification for the best candidate.

---

## 2. Architecture & Data Model

### 2.1 Hook Architecture: `useAntigravityQuotaResetMonitor`

A dedicated client-side React hook in `src/renderer/src/hooks/useAntigravityQuotaResetMonitor.ts`:

```ts
export type QuotaRecoveryCandidate = {
  accountId: string
  label: string
  resetsAt: number
  windowKey: 'session' | 'weekly'
}

export type QuotaRecoveryMonitorOptions = {
  /** Override threshold for considering active account strained. Default: 80% */
  activeStrainedThresholdPercent?: number
  /** Callback fired when an in-app recovery alert triggers. */
  onRecoveryAlert?: (candidate: QuotaRecoveryCandidate) => void
}
```

### 2.2 Component Hierarchy & Integration

- The monitor hook is mounted within `src/renderer/src/components/status-bar/AntigravitySwitcherMenu.tsx` (or the status-bar shell), ensuring it stays active whenever the Antigravity status indicator is mounted in the UI.
- It consumes:
  - `useAntigravityAccounts()`: supplies `accounts`, `activeAccount`, and `activeAccountId`.
  - Rate limits state from `useAppStore((s) => s.rateLimits.antigravity)` for live active usage.
  - `useResetCountdownClock`: supplies the synchronized boundary clock to check elapsed countdowns.
  - `switchAntigravityAccountAndRestartSession`: executes the account switch and terminal restart when the user clicks the toast action button.

---

## 3. Detailed Logic & Triggering Rules

### 3.1 Candidate Selection & Recovery Tracking

1. For every account $A \in \text{accounts}$ where $A.\text{id} \neq \text{activeAccountId}$:
   - Inspect $A.\text{lastUsage}$.
   - Check windows with a defined future timestamp: `session?.resetsAt` (primary) and `weekly?.resetsAt`.
   - If $A$ was previously recorded with high usage (`usedPercent >= 80%` or error status) and `resetsAt > 0`:
     - Register $A$ with key `(accountId, resetsAt)` into the monitor's tracking set.

### 3.2 Gating & Notification Trigger

1. **Clock Tick Evaluation:** On each synchronized tick of `useResetCountdownClock`:
   - Identify any tracked candidates where $\text{now} \ge \text{resetsAt}$ and `notified` is false.
2. **Active Account Evaluation:**
   - Active account is considered **strained** if:
     - `activeAccount.usage == null` (unknown/exhausted), OR
     - `activeAccount.usage.status === 'error'`, OR
     - `activeAccount.usage.session?.usedPercent >= 80`, OR
     - Any model bucket is at `usedPercent >= 90`.
3. **Toast Dispatch:**
   - If the active account is **strained**:
     - Pick the best candidate (the one with the earliest recovery time / highest quota).
     - Dispatch in-app toast via `sonner`:
       ```tsx
       toast.info(
         translate('accounts.antigravity.quotaRecovered', 'Quota recovered on {{account}}', {
           account: candidate.label
         }),
         {
           description: translate(
             'accounts.antigravity.quotaRecoveredDesc',
             'Session quota is restored and ready to use.'
           ),
           action: {
             label: translate('common.switch', 'Switch'),
             onClick: () => {
               void switchAntigravityAccountAndRestartSession({
                 targetAccountId: candidate.accountId,
                 target: activeTarget
               })
             }
           },
           duration: 9000
         }
       )
       ```
   - Mark `notified = true` for `(candidate.accountId, candidate.resetsAt)` to prevent repeat toasts.

### 3.3 Optimistic UI Reconciliation

- When $\text{now} \ge \text{resetsAt}$, the account's local representation in the switcher menu clears the exhausted status and reflects `usedPercent: 0` or `"Available"`.
- This ensures that when the user opens the dropdown, they immediately see available quota bars rather than stale high-usage bars from hours prior.

---

## 4. UI Presentation in `AntigravitySwitcherMenu`

### 4.1 Account List Badges & Countdowns

In `src/renderer/src/components/status-bar/AntigravitySwitcherMenu.tsx`:

- **Pending Reset:**
  - Displays countdown chip next to usage bar (e.g. `24m` or `11:15 AM`) using `formatRateLimitWindowChipLabel`.
- **Recovered / Ready:**
  - When $\text{now} \ge \text{resetsAt}$ or `usedPercent < 20%`:
  - Renders a compact badge:
    ```tsx
    <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] font-medium text-foreground">
      {translate('accounts.antigravity.ready', 'Ready')}
    </span>
    ```
- **Ordering:**
  - Within the dropdown, accounts that are ready or have available quota are sorted above accounts that are currently blocked with hours of remaining cooldown.

---

## 5. Error Handling & Edge Cases

1. **System Suspend / Sleep Wake-Up:**
   - When waking from sleep, multiple timers may expire simultaneously.
   - The monitor reconciles all expired entries in a single pass, marks them notified, and presents a single toast for the highest-priority account.
2. **Invalid or Missing Timestamps:**
   - If `resetsAt` is non-numeric, null, or in the past when first recorded without a high usage reading, it is ignored safely.
3. **Switch Verification & Fallback:**
   - Clicking `[Switch]` invokes `switchAntigravityAccountAndRestartSession`.
   - If the remote provider still returns a transient limit on initial poll, standard error state handling applies without UI crashes.

---

## 6. Testing Strategy

1. **Unit Tests (`useAntigravityQuotaResetMonitor.test.ts`):**
   - Verify candidate registration for accounts with future `resetsAt`.
   - Verify no toast is fired if the active account is healthy (`usedPercent < 80%`).
   - Verify toast is dispatched with `[Switch]` action when active account is strained and timer expires.
   - Verify deduplication: same `(accountId, resetsAt)` never fires twice.
   - Verify batch sleep recovery: multiple expired accounts produce only one toast.
   - Verify clicking toast action triggers `switchAntigravityAccountAndRestartSession`.
2. **Component Tests (`AntigravitySwitcherMenu.test.tsx`):**
   - Verify rendering of `"Ready"` badge when account quota has recovered.
   - Verify live countdown labels in account list items.
