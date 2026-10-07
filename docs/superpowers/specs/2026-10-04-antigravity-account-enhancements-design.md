# Design Spec: Antigravity Multi-Account Enhancements (Badging, Metadata & Smart Failover)

**Date:** 2026-10-04  
**Status:** Approved  
**Author:** Pair Programming Session (Geko & Antigravity)  

---

## 1. Overview & Goals

Following the implementation of native Windows Credential Manager support and the TabBar quick launch submenu, this specification details three enhancements to the Antigravity multi-account system in Orca:

1. **Visual Account Badging on Tabs:** Each Antigravity terminal tab visually indicates its active account via a colored status dot and alias label, with full email details in a tooltip.
2. **Account Metadata (Aliases & Colors):** Users can assign human-friendly aliases (e.g. *"Work"*, *"Personal"*) and select distinctive colors for each saved account in Settings, reflected across all UI surfaces.
3. **Assisted Smart Failover:** When an Antigravity session encounters quota exhaustion or rate limits (e.g., `429`, `RESOURCE_EXHAUSTED`), an interactive 1-click banner offers instant switching to an alternate account with available quota and seamless session restart.

---

## 2. Architecture & Data Model

### 2.1 Extended Account Types (`src/shared/antigravity-account-types.ts`)

Extend the account summary with optional `alias` and `color` fields:

```ts
export type AntigravityAccountMetadata = {
  alias?: string | null
  color?: string | null // Canonical token or hex string, e.g. '#3b82f6'
}

export type AntigravityAccountSummary = {
  id: string
  email: string | null
  subject: string | null
  authMethod: string
  alias?: string | null
  color?: string | null
  createdAt: number
  updatedAt: number
}

export type AntigravityAccountUpdateParams = {
  target: AntigravityAccountTarget
  accountId: string
  alias?: string | null
  color?: string | null
}
```

### 2.2 Vault Storage & Encryption (`src/main/antigravity/native-account-store.ts`)

- Account metadata is stored directly alongside credentials in the encrypted vault (`userData/antigravity-accounts/vault`).
- `updateAccountMetadata(id: string, metadata: AntigravityAccountMetadata)` performs an atomic read-modify-write cycle.
- Removing an account automatically purges its metadata, preventing orphaned records.

### 2.3 RPC Method Contract (`src/main/runtime/rpc/methods/antigravity-accounts.ts`)

Register a new RPC endpoint:
- **Name:** `accounts.antigravityUpdate`
- **Params:** `AntigravityAccountUpdateParams`
- **Returns:** Updated `AntigravityAccountState`
- **Client Client Wrapper:** Added to `runtime-antigravity-accounts-client.ts`.

---

## 3. Terminal Tab Session Association

### 3.1 Tab Types Extension (`src/shared/tab-types.ts` & `src/shared/terminal-tab-types.ts`)

Add `launchAccountId` to `TerminalTab` and `Tab`:

```ts
export type TerminalTab = {
  // ... existing fields
  launchAccountId?: string
}
```

- When launching via `QuickLaunchButton(accountId)` or when an account is explicitly selected, `launchAccountId` is passed into `launchAgentInNewTab('antigravity', { accountId })` and persisted on the tab.
- This binds the terminal tab to the specific Google account that spawned it, ensuring the tab indicator remains truthful even if the user switches active accounts globally in another window.

---

## 4. UI Presentation & Components

### 4.1 TabBar Item Rendering (`TabBarItemRow.tsx` / `TerminalTabLeadingIcon.tsx`)

For any tab where `launchAgent === 'antigravity'` and `launchAccountId` is defined:
- **Color Dot:** A 6px circular dot (`rounded-full`) painted with the account's color (or default blue if none set).
- **Alias Badge:** A compact typography badge (`text-[10px] text-muted-foreground font-medium`) displaying `alias` (or email username prefix if no alias exists), placed after the dot and before/alongside the terminal title.
- **Rich Tooltip:** Hovering over the dot or alias displays a tooltip containing the full account email (`email@domain.com`) and its current status.
- Strict adherence to `STYLEGUIDE.md`: zero disallowed arbitrary styling on shadcn primitives.

### 4.2 QuickLaunch Submenu (`QuickLaunchButton.tsx`)

Enhance each account entry in the `+` dropdown submenu:
- Prepend the account's colored dot.
- Display `Alias (email@domain.com)` or simply `email@domain.com` if no alias is configured.

### 4.3 Settings Management (`AntigravityAccountsSection.tsx`)

In the account cards of *Settings -> Accounts -> Antigravity*:
- Display the current alias and color badge.
- Add an "Edit" action triggering an inline edit row or modal:
  - Text input for `alias`.
  - Palette selector offering 6 theme-safe presets:
    - Blue (`#3b82f6`)
    - Emerald (`#10b981`)
    - Purple (`#8b5cf6`)
    - Amber (`#f59e0b`)
    - Rose (`#f43f5e`)
    - Cyan (`#06b6d4`)
  - "Save" button invoking `accounts.antigravityUpdate`.

---

## 5. Assisted Smart Failover Mechanism

### 5.1 Quota Exhaustion Detection

Quota errors are detected through two complementary avenues:
1. **PTY Terminal Output Observer:** A lightweight stream pattern matcher on active Antigravity terminals scanning for signatures:
   - `RESOURCE_EXHAUSTED`
   - `429 Too Many Requests`
   - `Quota exceeded for quota metric`
   - `Rate limit reached`
2. **Rate Limit Service Status:** Background usage polling (`antigravity-usage-fetcher.ts`) marking `failureKind === 'rate-limited'`.

### 5.2 Floating Interactive Banner (`TerminalQuotaFailoverBanner.tsx`)

When quota exhaustion is detected in an active tab:
- Renders an inline banner anchored at the top of the terminal pane:
  - **Icon:** `AlertTriangle` in amber/warning styling.
  - **Text:** *"Antigravity quota exhausted on [Account Alias]. Alternate account available: [Next Account Alias]."*
  - **Primary Action Button:** `[ Switch to [Next Account] & Restart ]`
  - **Dismiss Button:** `[ Dismiss / X ]`
- If multiple alternate accounts are available, a dropdown allows selecting which account to failover to.

### 5.3 Failover Execution Workflow

Upon user confirmation via the banner:
1. **Atomic Switch:** Call `accounts.antigravitySelect(newAccountId)` to update the Win32 Credential Manager target `gemini:antigravity`.
2. **Update Tab State:** Update `tab.launchAccountId` to `newAccountId`.
3. **PTY Respawn:** Send restart sequence or trigger pane remount to cleanly launch `agy` with the fresh token in the existing workspace cwd.
4. **Toast Notification:** Display feedback confirming the switch and resumption of the session.

---

## 6. Testing & Quality Strategy

1. **Unit Tests:**
   - `antigravity-accounts-service.test.ts`: Test `updateAccountMetadata` persistence and retrieval.
   - `QuickLaunchButton.test.ts`: Verify rendering of account aliases and color dots.
   - `TabBarItemRow.test.tsx`: Test presence of account badge and tooltip on tabs with `launchAccountId`.
   - `TerminalQuotaFailoverBanner.test.tsx`: Test banner appearance on quota error detection and triggering of account switch.
2. **Linting & Code Quality:**
   - Pass `pnpm run check:code-quality:changed` (0 findings).
   - Ensure all type assertions have required `SAFETY:` rationales.
   - Zero restyling violations of shadcn primitives per `STYLEGUIDE.md`.
3. **Build & Package Verification:**
   - Pass `pnpm tc:web` and `pnpm test`.
