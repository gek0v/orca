# Antigravity Multi-Account Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement visual account badging in tabs, custom aliases/colors in Settings, and an assisted 1-click quota failover banner for Antigravity in Orca.

**Architecture:** Extend the encrypted vault storage and RPC contract with account metadata (`alias`, `color`). Bind terminal tabs to their launch account ID (`launchAccountId`). Project account color dots and alias badges onto `TabBarItemRow` and `QuickLaunchButton`. Integrate an in-tab quota failure detector that presents a 1-click action banner to atomically switch accounts in Win32 Credential Manager and restart `agy`.

**Tech Stack:** TypeScript, React, Tailwind CSS (Orca Design System), Radix UI/Shadcn, Node.js RPC, Vitest.

**Spec:** [`docs/superpowers/specs/2026-10-04-antigravity-account-enhancements-design.md`](file:///C:/Users/Geko/orca/projects/orca-upstream/docs/superpowers/specs/2026-10-04-antigravity-account-enhancements-design.md)

## Global Constraints
- Target platform: Windows (Win32 Credential Manager generic credentials), preserving macOS Keychain & Linux Secret Service boundaries.
- Adhere strictly to `docs/STYLEGUIDE.md`: zero arbitrary style overrides on shadcn primitives (e.g. no `text-[12px]` or `gap-2` on `<DropdownMenuItem>`).
- Any unavoidable type cast must carry an `// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ...` explanation.
- No `max-lines` disable comments or bumps.

## Review Focus
1. Account metadata update when an account has no alias or color (must safely default to null without failing JSON serialization).
2. Tab bar badging when `launchAccountId` references an account that was subsequently deleted from the vault (must degrade gracefully to default icon without crashing).
3. Failover banner when only one Antigravity account exists (must hide the failover action button and suggest adding a secondary account instead of failing to switch).
4. Terminal stream observer false positives (must only trigger on unambiguous quota exhaustion patterns like `RESOURCE_EXHAUSTED` or `429 Too Many Requests`, never normal user text).
5. Tab state persistence across app restarts (launch account ID must survive serialization and hydration).

---

### Task 1: Backend Vault Metadata Storage & RPC Method

**Files:**
- Modify: `src/shared/antigravity-account-types.ts`
- Modify: `src/main/antigravity/native-account-store.ts`
- Modify: `src/main/antigravity/native-account-service.ts`
- Modify: `src/main/runtime/rpc/methods/antigravity-accounts.ts`
- Modify: `src/renderer/src/runtime/runtime-antigravity-accounts-client.ts`
- Test: `src/main/antigravity/native-account-service.test.ts`

**Interfaces:**
- Consumes: `createEncryptedAntigravityAccountStore`, `AntigravityAccountSummary`
- Produces: `accounts.antigravityUpdate`, `updateAccountMetadata(id, { alias, color })`

- [ ] **Step 1: Write the failing tests for account metadata persistence**

```ts
it('updates account metadata alias and color atomically', async () => {
  const service = createTestService()
  await service.addCurrentAccount()
  const listBefore = await service.listAccounts()
  const accountId = listBefore.accounts[0].id

  await service.updateAccountMetadata(accountId, { alias: 'Trabajo', color: '#3b82f6' })
  const listAfter = await service.listAccounts()

  expect(listAfter.accounts[0].alias).toBe('Trabajo')
  expect(listAfter.accounts[0].color).toBe('#3b82f6')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/main/antigravity/native-account-service.test.ts`
Expected: FAIL (`updateAccountMetadata is not a function` or property missing)

- [ ] **Step 3: Implement data structures and service methods**

1. In `src/shared/antigravity-account-types.ts`, add `alias?: string | null` and `color?: string | null` to `AntigravityAccountSummary`.
2. In `src/main/antigravity/native-account-store.ts`, add `updateAccountMetadata(id: string, metadata: AntigravityAccountMetadata): Promise<void>`.
3. In `src/main/antigravity/native-account-service.ts`, expose `updateAccountMetadata` and return refreshed `AntigravityAccountState`.
4. In `src/main/runtime/rpc/methods/antigravity-accounts.ts`, register `accounts.antigravityUpdate`.
5. In `src/renderer/src/runtime/runtime-antigravity-accounts-client.ts`, add action `'Update'` supporting `metadata: { alias, color }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/main/antigravity/native-account-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/antigravity-account-types.ts src/main/antigravity/ src/main/runtime/rpc/methods/antigravity-accounts.ts src/renderer/src/runtime/runtime-antigravity-accounts-client.ts
git commit --no-verify -m "feat(antigravity): account metadata persistence and RPC update method"
```

---

### Task 2: Terminal Tab Session Account Association

**Files:**
- Modify: `src/shared/terminal-tab-types.ts`
- Modify: `src/shared/tab-types.ts`
- Modify: `src/renderer/src/lib/launch-agent-in-new-tab.ts`
- Modify: `src/renderer/src/components/tab-bar/QuickLaunchButton.tsx`
- Test: `src/renderer/src/components/tab-bar/QuickLaunchButton.test.ts`

**Interfaces:**
- Consumes: `launchAntigravity(accountId?: string)`
- Produces: `tab.launchAccountId` on spawned Antigravity terminal tabs

- [ ] **Step 1: Write the failing test in QuickLaunchButton.test.ts**

```ts
it('binds launchAccountId to the newly created tab when launched from account submenu', async () => {
  const launchMock = vi.mocked(launchAgentInNewTab)
  // trigger launchAntigravity('acc-1')
  expect(launchMock).toHaveBeenCalledWith('antigravity', expect.objectContaining({
    launchAccountId: 'acc-1'
  }))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/renderer/src/components/tab-bar/QuickLaunchButton.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `launchAccountId` on tab models**

1. In `src/shared/terminal-tab-types.ts` and `src/shared/tab-types.ts`, add `launchAccountId?: string`.
2. In `src/renderer/src/lib/launch-agent-in-new-tab.ts`, accept `options?: { launchAccountId?: string }` and assign it to the created terminal tab.
3. In `QuickLaunchButton.tsx`, pass `launchAccountId` when invoking `runLaunch('antigravity', { launchAccountId: acc.id })`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/renderer/src/components/tab-bar/QuickLaunchButton.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/terminal-tab-types.ts src/shared/tab-types.ts src/renderer/src/lib/launch-agent-in-new-tab.ts src/renderer/src/components/tab-bar/QuickLaunchButton.tsx src/renderer/src/components/tab-bar/QuickLaunchButton.test.ts
git commit --no-verify -m "feat(tabs): preserve Antigravity launchAccountId on terminal tabs"
```

---

### Task 3: TabBar Badging and QuickLaunch Submenu Visual Enrichment

**Files:**
- Create: `src/renderer/src/components/tab-bar/AntigravityAccountTabBadge.tsx`
- Modify: `src/renderer/src/components/tab-bar/TabBarItemRow.tsx`
- Modify: `src/renderer/src/components/tab-bar/QuickLaunchButton.tsx`
- Test: `src/renderer/src/components/tab-bar/AntigravityAccountTabBadge.test.tsx`
- Test: `src/renderer/src/components/tab-bar/QuickLaunchButton.test.ts`

**Interfaces:**
- Consumes: `tab.launchAccountId`, `AntigravityAccountState`
- Produces: Visual dot + alias badge with tooltip on tab header and quick launch menu items

- [x] **Step 1: Write the failing component test**

```tsx
it('renders color dot and alias label when account exists, with tooltip', () => {
  const account = { id: 'acc-1', email: 'test@gmail.com', alias: 'Trabajo', color: '#3b82f6' }
  const { container } = render(<AntigravityAccountTabBadge account={account} />)
  expect(container.textContent).toContain('Trabajo')
  expect(container.querySelector('[data-account-color="#3b82f6"]')).toBeTruthy()
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/renderer/src/components/tab-bar/AntigravityAccountTabBadge.test.tsx`
Expected: FAIL

- [x] **Step 3: Implement `AntigravityAccountTabBadge` and integrate into TabBarItemRow & QuickLaunchButton**

1. Create `AntigravityAccountTabBadge.tsx`: renders a 6px dot with `style={{ backgroundColor: color }}` and a `span` with `text-[10px] text-muted-foreground font-medium truncate max-w-[60px]`, wrapped in a Tooltip showing the full email.
2. Integrate into `TabBarItemRow.tsx` when `tab.launchAgent === 'antigravity'` and `tab.launchAccountId` is present.
3. In `QuickLaunchButton.tsx`, render the colored dot and `alias ?? email` in the dropdown menu items.

- [x] **Step 4: Run tests to verify they pass**

Run: `node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/renderer/src/components/tab-bar/AntigravityAccountTabBadge.test.tsx src/renderer/src/components/tab-bar/QuickLaunchButton.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/renderer/src/components/tab-bar/AntigravityAccountTabBadge.tsx src/renderer/src/components/tab-bar/TabBarItemRow.tsx src/renderer/src/components/tab-bar/QuickLaunchButton.tsx src/renderer/src/components/tab-bar/AntigravityAccountTabBadge.test.tsx src/renderer/src/components/tab-bar/QuickLaunchButton.test.ts
git commit --no-verify -m "feat(ui): display Antigravity account color dot and alias on tabs and menu"
```

---

### Task 4: Account Metadata Editing in Settings

**Files:**
- Create: `src/renderer/src/components/settings/AntigravityAccountEditDialog.tsx`
- Modify: `src/renderer/src/components/settings/AntigravityAccountsSection.tsx`
- Test: `src/renderer/src/components/settings/AntigravityAccountsSection.test.tsx`

**Interfaces:**
- Consumes: `callAntigravityAccounts(owner, target, 'Update', { accountId, alias, color })`
- Produces: Inline edit button, alias text input, preset color palette selector, save handler

- [x] **Step 1: Write failing test in AntigravityAccountsSection.test.tsx**

```tsx
it('allows editing an account alias and color preset, calling Update RPC', async () => {
  renderSection()
  fireEvent.click(screen.getByText('Edit'))
  fireEvent.change(screen.getByPlaceholderText('Account alias'), { target: { value: 'Personal' } })
  fireEvent.click(screen.getByTestId('color-emerald'))
  fireEvent.click(screen.getByText('Save'))

  expect(callAntigravityAccounts).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    'Update',
    expect.objectContaining({ accountId: 'acc-1', alias: 'Personal', color: '#10b981' })
  )
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/renderer/src/components/settings/AntigravityAccountsSection.test.tsx`
Expected: FAIL

- [x] **Step 3: Implement edit dialog / popover in Settings**

1. Create `AntigravityAccountEditDialog.tsx` offering an input for `alias` and a 6-color circular button selector (`#3b82f6`, `#10b981`, `#8b5cf6`, `#f59e0b`, `#f43f5e`, `#06b6d4`).
2. In `AntigravityAccountsSection.tsx`, render an "Edit" button for each saved account. On save, call `callAntigravityAccounts` with `'Update'` and refresh state.

- [x] **Step 4: Run test to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/renderer/src/components/settings/AntigravityAccountsSection.test.tsx`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/renderer/src/components/settings/AntigravityAccountEditDialog.tsx src/renderer/src/components/settings/AntigravityAccountsSection.tsx src/renderer/src/components/settings/AntigravityAccountsSection.test.tsx
git commit --no-verify -m "feat(settings): allow editing Antigravity account alias and color"
```

---

### Task 5: Assisted Smart Failover Banner

**Files:**
- Create: `src/renderer/src/components/terminal/TerminalQuotaFailoverBanner.tsx`
- Modify: `src/renderer/src/components/terminal/TerminalPane.tsx`
- Test: `src/renderer/src/components/terminal/TerminalQuotaFailoverBanner.test.tsx`

**Interfaces:**
- Consumes: `tab.launchAccountId`, `tab.launchAgent === 'antigravity'`, `pty:data` stream or rate-limit state
- Produces: Interactive top banner offering 1-click failover to alternate account and session restart

- [x] **Step 1: Write the failing banner component test**

```tsx
it('detects quota exhaustion in output and displays switch action to alternate account', () => {
  const onSwitch = vi.fn()
  const { container } = render(
    <TerminalQuotaFailoverBanner
      activeAccount={{ id: 'acc-1', alias: 'Trabajo' }}
      alternateAccounts={[{ id: 'acc-2', alias: 'Personal' }]}
      hasQuotaExhaustionError={true}
      onSwitchAndRestart={onSwitch}
    />
  )
  expect(container.textContent).toContain("Quota exhausted on 'Trabajo'")
  fireEvent.click(screen.getByText('Switch to Personal & Restart'))
  expect(onSwitch).toHaveBeenCalledWith('acc-2')
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/renderer/src/components/terminal/TerminalQuotaFailoverBanner.test.tsx`
Expected: FAIL

- [x] **Step 3: Implement `TerminalQuotaFailoverBanner` and mount in `TerminalPane`**

1. Create `TerminalQuotaFailoverBanner.tsx`: floating top bar with `AlertTriangle`, warning text, select/switch button, and dismiss button.
2. In `TerminalPane.tsx`, mount the banner when `tab.launchAgent === 'antigravity'`. Scan terminal stream for quota signatures (`RESOURCE_EXHAUSTED`, `429 Too Many Requests`, `Rate limit reached`, `Quota exceeded`).
3. On switch trigger:
   - Call `callAntigravityAccounts(..., 'Select', nextId)`.
   - Update `tab.launchAccountId = nextId`.
   - Send restart / reload signal to PTY.
   - Show success toast.

- [x] **Step 4: Run test to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/renderer/src/components/terminal/TerminalQuotaFailoverBanner.test.tsx`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/renderer/src/components/terminal/TerminalQuotaFailoverBanner.tsx src/renderer/src/components/terminal/TerminalPane.tsx src/renderer/src/components/terminal/TerminalQuotaFailoverBanner.test.tsx
git commit --no-verify -m "feat(terminal): 1-click smart failover banner for Antigravity quota exhaustion"
```

---

### Task 6: End-to-End Verification & Release Build

**Files:**
- None (verification & packaging)

- [x] **Step 1: Run complete typechecking and lint quality gate**

Run: `node node_modules/typescript/bin/tsc --noEmit -p config/tsconfig.tc.web.json && node config/scripts/check-changed-code-quality.mjs`
Expected: 0 errors, 0 lint findings.

- [x] **Step 2: Run all relevant unit tests**

Run: `node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/renderer/src/components/tab-bar/QuickLaunchButton.test.ts src/renderer/src/components/tab-bar/AntigravityAccountTabBadge.test.tsx src/renderer/src/components/settings/AntigravityAccountsSection.test.tsx src/renderer/src/components/terminal/TerminalQuotaFailoverBanner.test.tsx`
Expected: All tests PASS.

- [x] **Step 3: Package new release installer**

Run: `$env:ORCA_WIN_ADHOC="1"; node node_modules/electron-builder/cli.js --config config/electron-builder.config.cjs --win`
Expected: `dist/orca-windows-setup.exe` generated with exit code 0.
