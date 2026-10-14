# Investigation & Remediation Report: Milestone 2 Forensic Audit Failure

**Agent**: `explorer_m2_fix_3`  
**Working Directory**: `C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\teamwork_preview_explorer_m2_fix_3`  
**Workspace Root**: `C:\Users\Geko\orca\workspaces\orca-upstream\main`  
**Mission**: Investigate root causes of `pnpm tc` failure, analyze `node out/cli/index.js goal validate` execution flow, verify all TypeScript configurations across the workspace, and formulate a comprehensive remediation strategy.

---

## 1. Observation

### Observation 1: The `pnpm tc` Command Definition and Execution Architecture

In `package.json`:

- Line 63: `"tc:node": "pnpm run typecheck:node"`
- Line 64: `"tc:cli": "pnpm run typecheck:cli"`
- Line 65: `"tc:web": "pnpm run typecheck:web"`
- Line 66: `"tc": "pnpm run typecheck"`
- Line 67: `"typecheck:node": "node node_modules/typescript/bin/tsc --noEmit -p config/tsconfig.node.json"`
- Line 68: `"typecheck:cli": "node node_modules/typescript/bin/tsc --noEmit -p config/tsconfig.tc.cli.json"`
- Line 69: `"typecheck:web": "node node_modules/typescript/bin/tsc --noEmit -p config/tsconfig.tc.web.json"`
- Line 71: `"typecheck": "node config/scripts/run-typecheck-projects-in-parallel.mjs"`

In `config/scripts/run-typecheck-projects-in-parallel.mjs`:

- Lines 11-15:
  ```js
  export const TYPECHECK_PROJECTS = [
    { config: 'tsconfig.node.json', heapGib: 7 },
    { config: 'tsconfig.tc.web.json', heapGib: 6 },
    { config: 'tsconfig.tc.cli.json', heapGib: 2 }
  ]
  ```
- Lines 58-75: Spawns `node node_modules/typescript/bin/tsc --noEmit -p config/<project>` for each project in parallel batches managed by memory budget (`admissibleHeapGib`).
- Lines 98-106: If any project check fails, it logs `tsc <project> exited with code <code>` and terminates with `process.exit(1)`.

### Observation 2: Root Cause of the Auditor's `pnpm tc` Failure

From the Forensic Audit Report (`teamwork_preview_auditor_m2_1/handoff.md`, lines 49-51):

```text
src/main/providers/orcad-native-pty-provider.test.ts(223,25): error TS2339: Property 'error' does not exist on type 'Readonly<{ outcome: "refused"; reason: WriteRefusalReason; }>'.
src/main/providers/orcad-native-pty-provider.test.ts(369,25): error TS2339: Property 'error' does not exist on type 'Readonly<{ outcome: "refused"; reason: WriteRefusalReason; }>'.
tsc tsconfig.node.json exited with code 1
```

In `src/shared/pty-write-settlement.ts`:

- Lines 30-38:
  ```ts
  export type WriteSettlement =
    | Readonly<{ outcome: 'accepted' }>
    | Readonly<{ outcome: 'refused'; reason: WriteRefusalReason }>
    | Readonly<{
        outcome: 'unverifiable'
        reason: WriteAmbiguityReason
        bytesHandedToTransport: boolean
      }>
  ```
- Line 43:
  ```ts
  export function writeRefused(reason: WriteRefusalReason): WriteSettlement {
    return Object.freeze({ outcome: 'refused', reason })
  }
  ```
- Notice: `WriteSettlement` explicitly has NO `error` property.

In `src/main/providers/orcad-native-pty-provider.ts`:

- Lines 149-158:
  ```ts
  writeWithSettlement(id: string, data: string): Promise<WriteSettlement> {
    return this.client
      .callRpc('pty.write', { id: String(id), terminalId: String(id), data })
      .then(() => WRITE_ACCEPTED)
      .catch((err: Error) => ({
        outcome: 'refused',
        reason: 'transport_rejected_before_handoff',
        error: err
      }))
  }
  ```
- Line 156 attached an illegal property `error: err`. While TypeScript's structural typing accepts excess properties when inferred through `.catch<U>()`, the return value is statically typed as `WriteSettlement`.
- In `src/main/providers/orcad-native-pty-provider.test.ts` (originally at lines 223 and 369), the test attempted:
  ```ts
  if (settlement.outcome === 'refused') {
    expect(settlement.reason).toBe('transport_rejected_before_handoff')
    expect(settlement.error.message).toContain('Terminal not found') // TS2339!
  }
  ```
  Since `settlement` in that branch is narrowed to `Readonly<{ outcome: "refused"; reason: WriteRefusalReason; }>`, reading `.error` triggered TypeScript error TS2339.

### Observation 3: Mechanism and Execution Flow of `node out/cli/index.js goal validate`

1. Entry Point: `src/cli/goals-dispatch.ts`:
   - Line 208: `async function handleValidate(ctx: HandlerContext): Promise<void>`
   - Line 209: Resolves target workspace path.
   - Lines 211-215: Loads `.orca/goals.json` and finds `activeGoal` (`goal-1791824736032`).
   - Line 220: Reads `activeGoal.validation.command`. In `.orca/goals.json`, line 37: `"command": "pnpm tc"`.
   - Lines 227-232: Instantiates `GoalsValidationRunner` and calls `runner.runValidation(workspacePath, activeGoal.validation.command, activeGoal.id)`.
2. Execution Runner: `src/main/goals/goals-validation-runner.ts`:
   - Lines 57-60: On Windows, resolves executable to `process.env.COMSPEC || 'cmd.exe'` and args to `['/d', '/s', '/c', command]`. Timeout is 300,000ms (5 minutes).
   - Lines 63-70: Executes via `runProcess` (`src/shared/child-process/run-process.ts`).
   - Lines 77-79: Writes combined output of stdout/stderr to `.orca/last_validation.log`.
   - Lines 81-83: Computes `success = !result.timedOut && result.code === 0`.
3. Updating Goal State:
   - Lines 234-245 of `src/cli/goals-dispatch.ts`: Updates `activeGoal.validation` status (`'success'` or `'failed'`), `exitCode`, `lastRunAt`, and `summaryTail`, saves `.orca/goals.json`, and projects `.orca/CURRENT_GOAL.md`.
   - Lines 251-258: Prints `Validation Passed (exit code 0): pnpm tc` or `Validation Failed (exit code 1): pnpm tc`.
4. Direct Execution Result in Workspace Today:
   - Command: `node out/cli/index.js goal validate`
   - Output:
     ```text
     Validation Passed (exit code 0): pnpm tc
     > orca@1.4.214 tc C:\Users\Geko\orca\workspaces\orca-upstream\main
     > pnpm run typecheck
     > orca@1.4.214 typecheck C:\Users\Geko\orca\workspaces\orca-upstream\main
     > node config/scripts/run-typecheck-projects-in-parallel.mjs
     ```
   - Exit code: `0`.

### Observation 4: Workspace-Wide TypeScript Configurations Verification

We surveyed and tested all TypeScript configurations across the workspace:

| Config Path                   | Extends / References                            | Scope & Purpose                                                                            | Test Command                                                     | Result                       |
| ----------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ---------------------------- |
| `config/tsconfig.node.json`   | `@electron-toolkit/tsconfig/tsconfig.node.json` | Covers Electron main process (`src/main/**/*`), shared (`src/shared/**/*`), preload, tests | `pnpm tc:node`                                                   | **Exit 0 (PASS)**            |
| `config/tsconfig.tc.cli.json` | `./tsconfig.cli.json` (Node20/Node16)           | CLI commands, handlers, goals runtime                                                      | `pnpm tc:cli`                                                    | **Exit 0 (PASS)**            |
| `config/tsconfig.tc.web.json` | `./tsconfig.web.json` (React JSX)               | Web renderer, UI components                                                                | `pnpm tc:web`                                                    | **Exit 0 (PASS)**            |
| `config/tsconfig.cli.json`    | `@electron-toolkit/tsconfig/tsconfig.node.json` | CLI production build (`out/cli/index.js`)                                                  | `pnpm run typecheck:tsc:cli`                                     | **Exit 0 (PASS)**            |
| `config/tsconfig.web.json`    | `@electron-toolkit/tsconfig/tsconfig.web.json`  | Web production build                                                                       | `pnpm run typecheck:tsc:web`                                     | **Exit 0 (PASS)**            |
| Root `tsconfig.json`          | References node, web, relay configs             | Solution root for IDE language servers                                                     | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **Exit 1 (TS5102, TS5090)**  |
| `config/tsconfig.e2e.json`    | `@electron-toolkit/tsconfig/tsconfig.node.json` | Playwright E2E tests (`tests/e2e/`)                                                        | `pnpm typecheck:e2e`                                             | Excluded from `pnpm tc` gate |

#### Root `tsconfig.json` Specific Finding:

Direct invocation of `tsc -p tsconfig.json` against TypeScript 7.0.2 emits:

```text
tsconfig.json(9,5): error TS5102: Option 'baseUrl' has been removed. Please remove it from your configuration.
  Use '"paths": {"*": ["./*"]}' instead.
tsconfig.json(11,15): error TS5090: Non-relative paths are not allowed. Did you forget a leading './'?
```

Root `tsconfig.json` lines 8-13 currently read:

```json
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/renderer/src/*"]
    }
  }
```

This does NOT affect `pnpm tc` because `pnpm tc` uses `run-typecheck-projects-in-parallel.mjs` targeting only the project configs (`tsconfig.node.json`, `tsconfig.tc.web.json`, `tsconfig.tc.cli.json`). However, for full TypeScript 7.0.2 compliance and clean IDE resolution, `baseUrl` should be omitted and `"@/*": ["./src/renderer/src/*"]` should be used.

---

## 2. Logic Chain

1. **Why `pnpm tc` Failed**:
   - `pnpm tc` delegates to `run-typecheck-projects-in-parallel.mjs`, which runs `tsc` on `config/tsconfig.node.json`.
   - `config/tsconfig.node.json` includes `src/main/**/*`.
   - `src/main/providers/orcad-native-pty-provider.test.ts` was written with assertions on `settlement.error` and `settlement.error.message` on lines 223 and 369.
   - Because `settlement` in that branch is strictly `Readonly<{ outcome: "refused"; reason: WriteRefusalReason; }>` (per `src/shared/pty-write-settlement.ts`), `tsc` rejected the property access with TS2339.
   - This failure cascaded to `pnpm tc` exiting with code 1.

2. **Why `node out/cli/index.js goal validate` Failed**:
   - In `.orca/goals.json`, the active goal's `validation.command` is configured as `"pnpm tc"`.
   - `node out/cli/index.js goal validate` executes `cmd.exe /d /s /c pnpm tc` through `GoalsValidationRunner`.
   - Because `pnpm tc` exited with code 1, `GoalsValidationRunner` recorded `status: 'failed', exitCode: 1`, wrote the error output to `.orca/last_validation.log`, and printed `Validation Failed (exit code 1): pnpm tc`.

3. **Current State in Workspace**:
   - Inspection of `src/main/providers/orcad-native-pty-provider.test.ts` reveals lines 220-223 and 365-368 now assert only `settlement.reason === 'transport_rejected_before_handoff'` and do NOT touch `.error`.
   - Direct execution of `pnpm tc:node`, `pnpm tc:cli`, `pnpm tc:web`, and `pnpm tc` now completes with exit code 0.
   - Direct execution of `node out/cli/index.js goal validate` now passes with exit code 0 (`Validation Passed (exit code 0): pnpm tc`).

4. **Remaining Code Hygiene Issue**:
   - In `src/main/providers/orcad-native-pty-provider.ts` line 156, `writeWithSettlement` still returns `{ outcome: 'refused', reason: 'transport_rejected_before_handoff', error: err }`.
   - Although TypeScript currently compiles it due to structural subtyping on `.catch()`, returning an object with an undeclared `error` field violates the `WriteSettlement` interface contract and fails to freeze the object.
   - Replacing this with `writeRefused('transport_rejected_before_handoff')` provides complete type adherence, immutability, and protection against regression.

---

## 3. Caveats

1. **Read-Only Role**:
   - As an explorer agent, I have not modified any source code, test files, or configurations in `src/` or `config/`.
2. **E2E Test Typecheck Excluded**:
   - `pnpm typecheck:e2e` (`config/tsconfig.e2e.json`) currently fails due to pre-existing type mismatches in unrelated E2E test fixtures (`tests/e2e/terminal-shortcuts.spec.ts`, etc.). It is explicitly not part of `pnpm tc` or the Milestone 2 acceptance criteria.
3. **Integration Test Timing**:
   - The live integration test `src/main/providers/orcad-native-pty-provider.integration.test.ts` passes cleanly in ~104ms when sending `exit\r\n` to the spawned `cmd.exe`.

---

## 4. Conclusion & Recommended Remediation Strategy

### Assessment

- The root cause of the Forensic Audit failure on Milestone 2 was the interface contract violation in `WriteSettlement` between `orcad-native-pty-provider.ts` and `orcad-native-pty-provider.test.ts`.
- `pnpm tc` and `node out/cli/index.js goal validate` currently exit with code 0 in the workspace because the invalid test assertions were removed.
- However, to ensure long-term code quality, prevent regressions, and ensure complete compliance with the audit findings, the implementation worker should perform the following targeted remediation steps.

### Comprehensive Remediation Plan

#### Step 1: Formalize `WriteSettlement` in `orcad-native-pty-provider.ts`

In `src/main/providers/orcad-native-pty-provider.ts`:

- Import `writeRefused` from `../../shared/pty-write-settlement` (lines 13-16).
- Replace lines 149-158:
  ```ts
  // BEFORE:
  writeWithSettlement(id: string, data: string): Promise<WriteSettlement> {
    return this.client
      .callRpc('pty.write', { id: String(id), terminalId: String(id), data })
      .then(() => WRITE_ACCEPTED)
      .catch((err: Error) => ({
        outcome: 'refused',
        reason: 'transport_rejected_before_handoff',
        error: err
      }))
  }

  // AFTER:
  writeWithSettlement(id: string, data: string): Promise<WriteSettlement> {
    return this.client
      .callRpc('pty.write', { id: String(id), terminalId: String(id), data })
      .then(() => WRITE_ACCEPTED)
      .catch(() => writeRefused('transport_rejected_before_handoff'))
  }
  ```

#### Step 2: Ensure Test Assertions Strictly Match Contract

In `src/main/providers/orcad-native-pty-provider.test.ts`:

- Ensure line 220-224 and lines 365-369 assert only:
  ```ts
  expect(settlement.outcome).toBe('refused')
  if (settlement.outcome === 'refused') {
    expect(settlement.reason).toBe('transport_rejected_before_handoff')
  }
  ```
- Confirm no properties outside `WriteSettlement` are referenced.

#### Step 3: Modernize Root `tsconfig.json` for TypeScript 7.0.2

In `tsconfig.json`:

- Remove `"baseUrl": "."`
- Update paths to relative:
  ```json
  {
    "files": [],
    "references": [
      { "path": "./config/tsconfig.node.json" },
      { "path": "./config/tsconfig.web.json" },
      { "path": "./config/tsconfig.relay.json" }
    ],
    "compilerOptions": {
      "paths": {
        "@/*": ["./src/renderer/src/*"]
      }
    }
  }
  ```

#### Step 4: Run Gate Verifications

Execute the following verification sequence in order:

1. `pnpm tc:node` (Node/Main/Pty typecheck)
2. `pnpm tc:cli` (CLI typecheck)
3. `pnpm tc:web` (Renderer typecheck)
4. `pnpm tc` (Full parallel typecheck gate)
5. `pnpm test src/main/providers/orcad-native-pty-provider.test.ts` (Provider unit tests)
6. `pnpm test src/main/providers/orcad-native-pty-provider.integration.test.ts` (Live daemon test)
7. `node out/cli/index.js goal validate` (Verify active goal status transitions to passed)

---

## 5. Verification Method

To independently verify the analysis and results:

```powershell
# 1. Verify individual TypeScript project compilation:
pnpm tc:node
pnpm tc:cli
pnpm tc:web

# 2. Verify parallel typecheck gate:
pnpm tc

# 3. Verify active goal validation via Orca CLI:
node out/cli/index.js goal validate

# 4. Verify live integration test against compiled orcad.exe:
pnpm test src/main/providers/orcad-native-pty-provider.integration.test.ts
```

**Invalidation Conditions**:

- If `pnpm tc` exits with non-zero code.
- If `node out/cli/index.js goal validate` outputs `Validation Failed`.
- If `writeWithSettlement` in `orcad-native-pty-provider.ts` returns properties not defined in `src/shared/pty-write-settlement.ts`.
