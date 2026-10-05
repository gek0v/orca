# Design Spec: Antigravity Multi-Account Quota Switcher & Persistent Dashboard

**Date:** 2026-10-05  
**Status:** Approved  
**Author:** Pair Programming Session (Geko & Antigravity)  

---

## 1. Overview & Goals

Building on the Antigravity multi-account foundation and the status bar rate-limit indicators, this specification defines the design for a **Multi-Account Quota Switcher & Dashboard** for Antigravity in Orca.

Currently, Orca only shows the rate limits and quota for the single active Antigravity account in the status bar. When users manage multiple accounts (e.g., work, personal, secondary projects), discovering which account still has available quota (Flash, Pro, 5H, Weekly) requires blindly switching accounts one by one.

This feature introduces:
1. **Persistent Quota Snapshots per Account:** Whenever an account is active and rate-limit polling runs, its usage reading and reset timestamp are durably stored with the account in the vault.
2. **Interactive `AntigravitySwitcherMenu` in Status Bar:** A rich dropdown menu (matching `ClaudeSwitcherMenu` and `CodexSwitcherMenu`) opened from the consolidated status-bar roster, displaying all configured accounts, their identity (emoji, alias, email), active badge, and inline quota bars with reset countdowns.
3. **One-Click Instant Account Switching:** Clicking any account in the list immediately switches the active operating system credential (`gemini:antigravity`), updates the status bar badges, and triggers a foreground rate-limit verification refresh.

---

## 2. Architecture & Data Model

### 2.1 Extended Account Types (`src/shared/antigravity-account-types.ts`)

Extend `AntigravityAccountSummary` with persistent rate-limit snapshot fields:

```ts
import type { ProviderRateLimits } from './rate-limit-types'

export type AntigravityAccountSummary = {
  id: string
  email: string | null
  subject: string | null
  authMethod: string
  alias?: string | null
  color?: string | null
  emoji?: string | null
  createdAt: number
  updatedAt: number
  lastUsage?: ProviderRateLimits | null
  lastUsageAt?: number | null
}
```

### 2.2 Encrypted Vault Storage (`src/main/antigravity/native-account-store.ts`)

- `StoredAntigravityAccount` is extended to accept `lastUsage?: ProviderRateLimits | null` and `lastUsageAt?: number | null`.
- `isAccount(value)` validation accommodates these optional properties, guaranteeing backward compatibility with existing vaults on disk.
- Store exposes an atomic snapshot updater:
  ```ts
  updateAccountUsage(accountId: string, usage: ProviderRateLimits, timestamp: number): void
  ```
  This performs a targeted mutation of `lastUsage` and `lastUsageAt` without altering credential secrets or account `updatedAt` timestamps.

### 2.3 Account Service Integration (`src/main/antigravity/native-account-service.ts`)

- Adds `recordUsageSnapshot(accountId: string, usage: ProviderRateLimits): Promise<AntigravityAccountState>`.
- When `selectAccount(id)` or `listAccounts()` runs, the returned `AntigravityAccountState` retains all accounts with their `lastUsage` snapshots intact.

---

## 3. Quota Snapshot Capture & Synchronization

### 3.1 Rate Limit Service Hook (`src/main/rate-limits/service/service-full-cycle-application.ts`)

When `antigravity-usage-fetcher.ts` returns a successful reading (`antigravity.status === 'ok'`):
- The rate-limit service captures the reading for the active host Antigravity account.
- It records the snapshot in `AntigravityAccountService` using `recordUsageSnapshot(activeAccountId, antigravity)`.
- If an account switch occurred during fetch, the snapshot is assigned to the account that was active when the fetch began.

### 3.2 Renderer Hook Cache (`src/renderer/src/hooks/useAntigravityAccounts.ts`)

- `useAntigravityAccounts()` supplies `accounts: AntigravityAccountSummary[]`.
- For the active account, UI components prioritize live state from `useAppStore(s => s.rateLimits.antigravity)` when available.
- For inactive accounts, components read `account.lastUsage`.
- Because Antigravity returns absolute UTC timestamps (`reset_time`, e.g., `"2026-10-07T08:08:35Z"`), reset countdowns (`resetsAt - Date.now()`) remain strictly accurate in real time across all accounts without requiring background CLI spawns for inactive accounts.

---

## 4. UI Presentation & Components

### 4.1 Component: `AntigravitySwitcherMenu.tsx` (`src/renderer/src/components/status-bar/AntigravitySwitcherMenu.tsx`)

Following the design pattern of `ClaudeSwitcherMenu.tsx` and `CodexSwitcherMenu.tsx`:

- **Container:** Wraps `ProviderDetailsMenu` (or behaves as a submenu item in `UsageRosterPanel`).
- **Header:** Label displaying localized *"Antigravity Accounts"* with expand/collapse chevron.
- **Account List:**
  - Iterates over all registered accounts in `useAntigravityAccounts()`.
  - For each account item:
    - **Identity:** Displays account emoji (or color dot), alias (or truncated email), and an `"Active"` badge for the currently selected account.
    - **Quota Indicators:** Uses `InlineUsageBars` or bucket progress bars to show `GM · WL`, `GM · 5H` (or Flash/Pro) usage percentages and reset countdown (e.g., *"Reset in 2h 45m"*).
    - **Empty State:** For accounts without prior usage snapshot: *"No usage data yet · Click to activate"*.
    - **Switch Action:** Clicking an inactive row triggers `selectAccount(account.id)`, disabling during `isSwitching` and updating the status bar badge and active credentials immediately.
- **Footer:** Direct action *"Manage accounts..."* navigating to `Settings > Antigravity Accounts`.

### 4.2 Status Bar Roster Wiring (`src/renderer/src/components/status-bar/StatusBarSurface.tsx`)

In `StatusBarSurface.tsx`, connect the Antigravity provider row in `UsageRosterPanel`:

```tsx
if (p.provider === 'antigravity') {
  return (
    <AntigravitySwitcherMenu
      antigravity={p}
      compact={compact}
      iconOnly={false}
      asSubmenu
      triggerContent={rowNode}
    />
  )
}
```

### 4.3 Localization (`src/renderer/src/i18n/locales/en.json` & `es.json`)

Register localized keys for:
- Menu title: *"Antigravity Accounts"* / *"Cuentas de Antigravity"*
- Active label: *"Active"* / *"Activa"*
- Switch section: *"Switch to"* / *"Cambiar a"*
- Empty quota: *"No usage data yet"* / *"Sin datos de uso aún"*

---

## 5. Verification & Testing

1. **Unit Tests:**
   - `native-account-store.test.ts`: Verify `updateAccountUsage` preserves existing account fields and persists `lastUsage` and `lastUsageAt`.
   - `native-account-service.test.ts`: Verify `recordUsageSnapshot` updates state and lists accounts with their snapshots.
   - `AntigravitySwitcherMenu.test.tsx`: Verify rendering of multiple accounts, quota bars, active state, and switching interactions.
2. **Quality Gates:**
   - `pnpm tc` (typecheck)
   - `pnpm test src/main/antigravity/` and `pnpm test src/renderer/src/components/status-bar/`
   - `oxlint` / `pnpm run check:code-quality:changed`
