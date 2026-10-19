# Antigravity Task Pool & Multi-Account Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable coordinating agents in Orca to parallelize tasks using an automatically quota-balanced Antigravity account pool configured by the user in Settings.

**Architecture:** Extend the Antigravity encrypted vault and Settings UI with a task pool toggle. Implement a backend quota selector that calculates available headroom across 5h and weekly rate-limit windows. Integrate a `--pool` flag into `orca orchestration worker-start` (and `orca task` alias) to dynamically resolve and inject `launchAccountId` into isolated worker PTY spawns. Update agent preambles so coordinators leverage the pool during sub-dispatching.

**Tech Stack:** TypeScript, Node.js, Electron (Main & Renderer), React (shadcn/ui, Tailwind CSS), Zod, RPC Contracts, PTY Process Isolation.

**Spec:** [`docs/superpowers/specs/2026-10-19-antigravity-task-pool-orchestration-design.md`](file:///D:/Workspaces/orca-upstream/docs/superpowers/specs/2026-10-19-antigravity-task-pool-orchestration-design.md)

---

## Global Constraints

- **Single Source of Truth:** Multi-account process isolation relies on `~/.gemini/profiles/<accountId>/` profile directories with symlinks/junctions pointing to canonical `~/.gemini/antigravity-cli/`.
- **Stateless Concurrency:** Selection is stateless $\text{argmax}(\text{Headroom})$ with tie-breaking on `lastUsedAt`; no artificial in-flight blocking or concurrency gating.
- **Fail Fast on Pool Depletion:** If all pool accounts are rate-limited or exhausted (100% used), throw `OrchestrationError('resource_exhausted', ...)` reporting the earliest reset timestamp.
- **Local-Only Scope (Phase 1):** `--pool` is restricted to local execution; combining `--pool` with `--on <remote>` must throw `OrchestrationError('invalid_argument', ...)`.
- **Agent Defaulting:** Passing `--pool` without `--agent` defaults to `'antigravity'`; passing `--pool` with a non-Antigravity agent must throw `invalid_argument`.
- **UI Design System:** In `AntigravityAccountRow`, use shadcn `Switch` and `Badge` primitives with standard tokens (`bg-primary/10 text-primary border-primary/20`, `text-[11px] text-muted-foreground`) following `docs/STYLEGUIDE.md`.

---

## Review Focus

1. **Empty Task Pool:** User runs `orca orchestration worker-start --pool` but has toggled 0 accounts into the pool in Settings -> Must fail fast with a clear `invalid_argument` error directing them to Settings > Accounts.
2. **All Pool Accounts Exhausted:** Every pool account has reached 100% usage or is in a rate-limited status -> Must fail fast with `resource_exhausted` containing the earliest `resetsAt` timestamp.
3. **Account Unprobed/Missing Usage:** An account added to the pool has not yet completed a background rate-limit probe -> Must be treated optimistically with 100% headroom and queue an async probe rather than stalling or throwing.
4. **Bottleneck Window Selection:** Account A has 80% free in 5h window but only 10% free in weekly window; Account B has 50% free in both -> Account B must win ($50\% > \min(80\%, 10\%) = 10\%$).
5. **Session Safety:** Spawning a worker via `--pool` must assign `launchAccountId` to that specific child PTY environment without modifying `vault.selectedAccountId` or the active window/tab account.

---

### Task 1: Vault & Account Summary Model Extension (`inTaskPool`)

**Files:**
- Modify: `src/shared/antigravity-account-types.ts`
- Modify: `src/main/antigravity/native-account-store.ts`
- Modify: `src/main/antigravity/native-account-service.ts`
- Test: `src/main/antigravity/native-account-store.test.ts`
- Test: `src/main/antigravity/native-account-service.test.ts`

**Interfaces:**
- Produces: `inTaskPool?: boolean` on `AntigravityAccountSummary` and `AntigravityAccountRecord`. Method `setAccountPoolMembership(accountId: string, inPool: boolean): Promise<AntigravityAccountSummary>`.

- [ ] **Step 1: Write failing tests for vault pool membership persistence**

In `src/main/antigravity/native-account-store.test.ts`:
```ts
it('persists and updates inTaskPool flag on account records', () => {
  const store = createEncryptedAntigravityAccountStore(testVaultPath)
  store.addAccount(mockAccountRecord({ id: 'acc-1', inTaskPool: true }))
  expect(store.read().accounts[0].inTaskPool).toBe(true)
  store.updateAccount('acc-1', { inTaskPool: false })
  expect(store.read().accounts[0].inTaskPool).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/antigravity/native-account-store.test.ts`  
Expected: FAIL (property `inTaskPool` not recognized or not preserved).

- [ ] **Step 3: Implement `inTaskPool` field in types and store**

In `src/shared/antigravity-account-types.ts`, add `inTaskPool?: boolean` to `AntigravityAccountRecord` and `AntigravityAccountSummary`.  
In `native-account-store.ts`, preserve `inTaskPool` across read/write/update mutations.  
In `native-account-service.ts`, add `setAccountPoolMembership(id: string, inPool: boolean)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/main/antigravity/native-account-store.test.ts src/main/antigravity/native-account-service.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/antigravity-account-types.ts src/main/antigravity/native-account-store.ts src/main/antigravity/native-account-service.ts src/main/antigravity/native-account-store.test.ts src/main/antigravity/native-account-service.test.ts
git commit -m "feat(antigravity): add inTaskPool membership flag to account vault and service"
```

---

### Task 2: Quota-Aware Task Pool Selector (`selectAntigravityPoolAccount`)

**Files:**
- Create: `src/main/antigravity/antigravity-task-pool-selector.ts`
- Test: `src/main/antigravity/antigravity-task-pool-selector.test.ts`

**Interfaces:**
- Consumes: `AntigravityAccountRecord` from `native-account-store.ts`, `ProviderRateLimits` from `src/shared/rate-limit-types.ts`.
- Produces: `selectAntigravityPoolAccount(options: { vault: AntigravityAccountVault; getRateLimits: (accountId: string) => ProviderRateLimits | null; onTriggerProbe?: (accountId: string) => void }): { accountId: string; headroom: number }`

- [ ] **Step 1: Write failing tests for pool selection logic**

In `src/main/antigravity/antigravity-task-pool-selector.test.ts`:
```ts
it('throws when no accounts are marked in task pool', () => {
  expect(() => selectAntigravityPoolAccount({ vault: { accounts: [mockAcc({ inTaskPool: false })] }, getRateLimits: () => null }))
    .toThrowError(/No Antigravity accounts are configured in the Task Pool/)
})

it('selects account with highest bottleneck headroom between 5h and weekly windows', () => {
  const accA = mockAcc({ id: 'acc-a', inTaskPool: true })
  const accB = mockAcc({ id: 'acc-b', inTaskPool: true })
  // Acc A: 5h has 80% free (20% used), weekly has 10% free (90% used) -> Headroom = 10%
  // Acc B: 5h has 50% free (50% used), weekly has 50% free (50% used) -> Headroom = 50%
  const rateLimits = {
    'acc-a': { session: { usedPercent: 20 }, weekly: { usedPercent: 90 }, status: 'ok' },
    'acc-b': { session: { usedPercent: 50 }, weekly: { usedPercent: 50 }, status: 'ok' }
  }
  const result = selectAntigravityPoolAccount({
    vault: { accounts: [accA, accB] },
    getRateLimits: (id) => rateLimits[id]
  })
  expect(result.accountId).toBe('acc-b')
})

it('treats unprobed accounts optimistically with 100% headroom and requests background probe', () => {
  const acc = mockAcc({ id: 'acc-new', inTaskPool: true })
  const probeMock = vi.fn()
  const result = selectAntigravityPoolAccount({
    vault: { accounts: [acc] },
    getRateLimits: () => null,
    onTriggerProbe: probeMock
  })
  expect(result.accountId).toBe('acc-new')
  expect(probeMock).toHaveBeenCalledWith('acc-new')
})

it('throws resource_exhausted with earliest reset time when all accounts are rate-limited or 100% full', () => {
  const acc = mockAcc({ id: 'acc-full', inTaskPool: true })
  const rateLimits = { session: { usedPercent: 100, resetsAt: 1770000000000 }, weekly: { usedPercent: 40 }, status: 'ok' }
  expect(() => selectAntigravityPoolAccount({ vault: { accounts: [acc] }, getRateLimits: () => rateLimits }))
    .toThrowError(/All accounts in the Antigravity Task Pool have reached their usage limits/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/antigravity/antigravity-task-pool-selector.test.ts`  
Expected: FAIL (file does not exist).

- [ ] **Step 3: Implement `selectAntigravityPoolAccount`**

In `src/main/antigravity/antigravity-task-pool-selector.ts`:
- Filter `vault.accounts.filter(a => a.inTaskPool)`.
- For each, compute `headroom = min(100 - (session?.usedPercent ?? 0), 100 - (weekly?.usedPercent ?? 0))`.
- Handle unprobed accounts: headroom = 100, call `onTriggerProbe(a.id)`.
- Exclude accounts with `status === 'rate-limited'` or `headroom <= 0`.
- Throw appropriate `OrchestrationError` when pool empty or exhausted with formatted timestamp.
- Tie-break by `lastUsedAt ?? 0` ascending.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/main/antigravity/antigravity-task-pool-selector.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/antigravity/antigravity-task-pool-selector.ts src/main/antigravity/antigravity-task-pool-selector.test.ts
git commit -m "feat(antigravity): implement quota-aware task pool account selector"
```

---

### Task 3: Unconditional Rate Limit Probing for Pool Accounts

**Files:**
- Modify: `src/main/rate-limits/service/` or `src/main/rate-limits/antigravity-usage-fetcher.ts`
- Test: `src/main/rate-limits/service/*.test.ts`

**Interfaces:**
- Consumes: `vault.accounts.filter(a => a.inTaskPool)`.
- Produces: Probing includes all `inTaskPool` accounts in periodic refresh cycles regardless of `statusBarItems` setting.

- [ ] **Step 1: Write failing test verifying pool accounts are included in refresh**

In rate limit service test:
Verify that an account with `inTaskPool: true` is polled even when `statusBarItems` excludes `'antigravity'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/rate-limits/`  
Expected: FAIL

- [ ] **Step 3: Implement pool account inclusion in rate limit refresh loop**

In the rate limit prober cycle, include accounts present in `vault.accounts.filter(a => a.inTaskPool || a.id === vault.selectedAccountId)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/main/rate-limits/`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/rate-limits/
git commit -m "feat(antigravity): ensure task pool accounts are probed in rate limit cycles"
```

---

### Task 4: CLI & RPC Worker Start Pool Integration

**Files:**
- Modify: `src/shared/rpc-contract/orchestration-worker-start-params.ts`
- Modify: `src/cli/specs/orchestration-worker-specs.ts`
- Modify: `src/cli/handlers/orchestration/worker-launch-handler.ts`
- Modify: `src/cli/specs/index.ts` & `src/cli/handler-group-manifest.ts`
- Modify: `src/main/runtime/rpc/methods/orchestration/worker/workers.ts`
- Modify: `src/main/runtime/rpc/methods/orchestration/worker/local-worker-start.ts`
- Test: `src/cli/handlers/orchestration-worker-cli.test.ts`
- Test: `src/main/runtime/rpc/methods/orchestration/worker/workers-new-worktree.test.ts`

**Interfaces:**
- Consumes: `--pool` flag in CLI, `WorkerStartParams.pool` in RPC.
- Produces: Resolves pool account via `selectAntigravityPoolAccount`, maps to `launchAccountId`, rejects `--pool` with `--on`, defaults `--agent antigravity`. Registers `orca task` alias.

- [ ] **Step 1: Write failing tests for `--pool` CLI spec and worker-start handler**

Verify:
- `orca orchestration worker-start --pool` accepts `--pool` flag.
- When `--pool` is present with `--on`, throws `invalid_argument`.
- When `--pool` is present without `--agent`, defaults agent to `'antigravity'`.
- `orca task` routes as an alias to worker-start.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/cli/handlers/orchestration-worker-cli.test.ts`  
Expected: FAIL (unrecognized flag `--pool` or unknown command `orca task`).

- [ ] **Step 3: Implement `--pool` parameter, alias, and RPC resolution**

- In `orchestration-worker-start-params.ts`: add `pool: z.boolean().optional()`.
- In `orchestration-worker-specs.ts`: add `'pool'` to `allowedFlags`.
- In `worker-launch-handler.ts`: forward `pool: getOptionalBooleanFlag(flags, 'pool')`.
- In `handler-group-manifest.ts` and `specs/index.ts`: register `orca task` alias.
- In `workers.ts` / `local-worker-start.ts`:
  - If `params.pool`:
    - If `params.on`: throw `OrchestrationError('invalid_argument', '--pool is only supported for local worker execution.')`.
    - If `!params.agent`: set `params.agent = 'antigravity'`.
    - If `params.agent !== 'antigravity'`: throw `OrchestrationError('invalid_argument', '--pool is currently only supported for --agent antigravity.')`.
    - Call `selectAntigravityPoolAccount()`, pass `accountId` as `launchAccountId` into `placeWorkerAgent`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/cli/handlers/orchestration-worker-cli.test.ts src/main/runtime/rpc/methods/orchestration/worker/workers-new-worktree.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/rpc-contract/orchestration-worker-start-params.ts src/cli/specs/orchestration-worker-specs.ts src/cli/handlers/orchestration/worker-launch-handler.ts src/cli/specs/index.ts src/cli/handler-group-manifest.ts src/main/runtime/rpc/methods/orchestration/worker/
git commit -m "feat(orchestration): support --pool flag and orca task alias for Antigravity worker start"
```

---

### Task 5: Settings UI - Pool Toggle on Antigravity Accounts

**Files:**
- Modify: `src/renderer/src/components/settings/AntigravityAccountRow.tsx`
- Modify: `src/renderer/src/components/settings/AntigravityAccountsSection.tsx`
- Test: `src/renderer/src/components/settings/AntigravityAccountsSection.test.tsx`

**Interfaces:**
- Consumes: `account.inTaskPool` from `AntigravityAccountSummary`.
- Produces: Interactive Switch and Badge component on each account card in Settings > Accounts.

- [ ] **Step 1: Write failing tests for UI pool switch rendering and interaction**

In `AntigravityAccountsSection.test.tsx`:
```tsx
it('renders task pool toggle switch and calls updateAccount when toggled', async () => {
  const onTogglePool = vi.fn()
  render(<AntigravityAccountRow account={{ id: 'acc-1', inTaskPool: false }} onTogglePool={onTogglePool} ... />)
  const toggle = screen.getByRole('switch', { name: /pool de tareas/i })
  expect(toggle).not.toBeChecked()
  await userEvent.click(toggle)
  expect(onTogglePool).toHaveBeenCalledWith('acc-1', true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/renderer/src/components/settings/AntigravityAccountsSection.test.tsx`  
Expected: FAIL (switch not found).

- [ ] **Step 3: Implement pool switch and badge in `AntigravityAccountRow`**

In `AntigravityAccountRow.tsx`:
- Add a shadcn `Switch` control with accessible label.
- Display a small `Badge` ("Pool de tareas" / "Task pool") styled with `bg-primary/10 text-primary border-primary/20`.
- Wire `onTogglePool(account.id, checked)` to invoke IPC account mutation.
- Run `pnpm run check:code-quality:changed` to verify Tailwind classes meet STYLEGUIDE.md constraints.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/renderer/src/components/settings/AntigravityAccountsSection.test.tsx`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/settings/AntigravityAccountRow.tsx src/renderer/src/components/settings/AntigravityAccountsSection.tsx src/renderer/src/components/settings/AntigravityAccountsSection.test.tsx
git commit -m "feat(renderer): add task pool toggle switch to Antigravity account rows in Settings"
```

---

### Task 6: Dispatch Preamble & Orchestration Skill Documentation

**Files:**
- Modify: `src/main/runtime/orchestration/preamble.ts`
- Modify: `src/cli/bundled-skill-guides.ts`
- Test: `src/main/runtime/orchestration/preamble.test.ts`

**Interfaces:**
- Consumes: Sub-dispatch instruction template in `preamble.ts`.
- Produces: Updated sub-dispatch section in preambles containing `--pool` example with explanation.

- [ ] **Step 1: Write failing test for updated dispatch preamble with `--pool`**

In `src/main/runtime/orchestration/preamble.test.ts`:
Verify that `buildDispatchPreamble({ canDispatchSubWorkers: true, ... })` includes `--pool` in the sub-dispatch command example.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/runtime/orchestration/preamble.test.ts`  
Expected: FAIL

- [ ] **Step 3: Update preamble and skill guides**

In `src/main/runtime/orchestration/preamble.ts`:
Update `buildSubDispatchSection`:
```sh
  ${cli} orchestration run-create --objective "<what the sub-workers are for>" --json
  ${cli} orchestration task-create --spec "<sub-task>" --json
  ${cli} orchestration worker-start --task <task_id> --worktree current --agent antigravity --pool --json
```
Explain that `--pool` distributes parallel sub-tasks across available Google accounts to prevent rate-limiting.  
In `src/cli/bundled-skill-guides.ts`: add `--pool` description to orchestration guide.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/main/runtime/orchestration/preamble.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/runtime/orchestration/preamble.ts src/cli/bundled-skill-guides.ts src/main/runtime/orchestration/preamble.test.ts
git commit -m "docs(orchestration): document --pool in dispatch preamble and orchestration skill guide"
```

---

### Task 7: Full System Verification

**Files:**
- All changed files across main, renderer, cli, and shared.

- [ ] **Step 1: Run comprehensive typecheck**
Run: `pnpm tc`
Expected: 0 errors.

- [ ] **Step 2: Run design system and code quality linting**
Run: `pnpm run check:code-quality:changed`
Expected: 0 warnings, 0 errors.

- [ ] **Step 3: Run affected test suites**
Run: `pnpm test src/main/antigravity/ src/main/runtime/rpc/methods/orchestration/ src/renderer/src/components/settings/AntigravityAccount`
Expected: All tests PASS.

- [ ] **Step 4: Commit verification checkpoint if needed**
```bash
git commit --allow-empty -m "chore(antigravity): complete task pool orchestration verification"
```
