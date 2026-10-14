# Handoff Report: Reviewer Audit for Milestone 2 Remediation

**Agent**: `reviewer_m2_it2_2`  
**Roles**: reviewer, critic  
**Working Directory**: `C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\teamwork_preview_reviewer_m2_it2_2`  
**Workspace Root**: `C:\Users\Geko\orca\workspaces\orca-upstream\main`  
**Verdict**: **APPROVE**

---

## 1. Observation

### Observation 1: Windows Shell Argument Resolution in `src/main/providers/orcad-pty-spawn-plan.ts`

Lines 22-35 in `src/main/providers/orcad-pty-spawn-plan.ts`:

```ts
const resolved = resolveWindowsShellLaunchArgs(
  shellPath,
  rawCwd,
  defaultCwd,
  undefined,
  opts.command
)
command = shellPath
args =
  opts.terminalShellArgs && opts.terminalShellArgs.length > 0 && !opts.command
    ? [...opts.terminalShellArgs]
    : [...resolved.shellArgs]
cwd = resolved.effectiveCwd
```

- Direct programmatic inspection verified that when `terminalShellArgs` is passed (e.g., `['/c', 'echo test']`) without `opts.command`:
  - `command`: `'cmd.exe'`
  - `args`: `['/c', 'echo test']`
  - `/K` is **not** prepended or appended.
- When an interactive pane is spawned (without `terminalShellArgs`):
  - `args`: `['/K', 'chcp 65001 > nul']`
  - `/K` and code page setup remain intact for interactive shell sessions.

### Observation 2: Live Integration Test in `src/main/providers/orcad-native-pty-provider.integration.test.ts`

In `src/main/providers/orcad-native-pty-provider.integration.test.ts`:

- The previous synthetic workaround (`provider.write(spawnRes.id, 'exit\r\n')`) has been completely removed.
- Lines 52-79 now spawn `cmd.exe` with `terminalShellArgs: ['/c', 'echo NATIVE_ORCAD_LIVE_SUCCESS']` and await natural process termination:

```ts
const spawnRes = await provider.spawn({
  shellOverride: cmd,
  terminalShellArgs: args,
  cols: 80,
  rows: 24,
  cwd: process.cwd()
})

expect(spawnRes.id).toBeDefined()
expect(spawnRes.pid).toBeTypeOf('number')

const code = await Promise.race([
  exitPromise,
  new Promise<number>((_, reject) =>
    setTimeout(() => reject(new Error('PTY exit timed out')), 5000)
  )
])

expect(code).toBe(0)
const fullOutput = outputChunks.join('')
expect(fullOutput).toContain('NATIVE_ORCAD_LIVE_SUCCESS')
```

- Real binary presence was verified on disk: `target/release/orcad.exe` exists (`true`), and `resolveNativeBinary` resolves to `C:\Users\Geko\orca\workspaces\orca-upstream\main\target\release\orcad.exe`.
- Running `pnpm test src/main/providers/orcad-native-pty-provider.integration.test.ts` completed in 96ms with exit code 0:

```text
 ✓  bun  src/main/providers/orcad-native-pty-provider.integration.test.ts (1 test) 96ms
Test Files  1 passed (1)
     Tests  1 passed (1)
```

### Observation 3: Unit Tests and Provider Invariant Verification

- `pnpm test src/main/providers/orcad-native-pty-provider.test.ts`:

```text
 ✓  bun  src/main/providers/orcad-native-pty-provider.test.ts (6 tests) 231ms
Test Files  1 passed (1)
     Tests  6 passed (6)
```

- `pnpm test src/main/daemon/daemon-provider-init.test.ts config/scripts/electron-builder-native-resources.test.mjs`:

```text
 ✓  bun  config/scripts/electron-builder-native-resources.test.mjs (2 tests) 7ms
 ✓  bun  src/main/daemon/daemon-provider-init.test.ts (3 tests) 9ms
Test Files  2 passed (2)
     Tests  5 passed (5)
```

- Total tests passed: 12 tests across 4 files, 0 failures.

### Observation 4: TypeScript and Goal Validation

- Running `pnpm tc`:

```text
> orca@1.4.214 tc C:\Users\Geko\orca\workspaces\orca-upstream\main
> pnpm run typecheck
> orca@1.4.214 typecheck C:\Users\Geko\orca\workspaces\orca-upstream\main
> node config/scripts/run-typecheck-projects-in-parallel.mjs
(Exited with code 0)
```

- Running `node out/cli/index.js goal validate`:

```text
Validation Passed (exit code 0): pnpm tc
(Exited with code 0)
```

### Observation 5: Code Quality and Linting

- Running `npx oxlint src/main/providers/orcad-native-pty-provider.ts src/main/providers/orcad-pty-spawn-plan.ts src/main/providers/orcad-native-pty-provider.test.ts src/main/providers/orcad-native-pty-provider.integration.test.ts`:

```text
Found 0 warnings and 0 errors.
Finished in 96ms on 4 files with 177 rules using 16 threads.
```

### Observation 6: Integrity & Adversarial Audit

Checked actively for integrity violations:

1. Hardcoded test results / expected outputs: **None**. The spawn plan uses pure option-mapping logic; client and provider stream real JSON-RPC frames over Windows Named Pipes.
2. Dummy or facade implementations: **None**. `OrcadNativePtyProvider` implements all `IPtyProvider` methods. `orcad.exe` is the real Rust ConPTY daemon binary built with release optimizations.
3. Shortcuts bypassing intended task: **None**. The prior `provider.write('exit\r\n')` workaround was eliminated.
4. Fabricated verification outputs: **None**. All test suites, typechecks, and goal validations were executed live and observed directly.
5. Self-certifying work without independent verification: **None**.

---

## 2. Logic Chain

1. **Root Cause Analysis (Observation 1)**: In Windows `cmd.exe`, passing `/K` forces the interpreter to remain interactive indefinitely. Prior code always included `resolved.shellArgs` (which starts with `/K`), causing commands intended to execute and exit to hang until manually killed. The remediation in `orcad-pty-spawn-plan.ts` lines 30-33 correctly branches on `opts.terminalShellArgs && opts.terminalShellArgs.length > 0 && !opts.command` to pass caller-specified arguments directly without `/K`.
2. **Workaround Elimination (Observation 2)**: In `orcad-native-pty-provider.integration.test.ts`, removing `provider.write(spawnRes.id, 'exit\r\n')` verifies that `cmd.exe /c` exits naturally. The test succeeded in 96ms against the real release binary `target/release/orcad.exe`, proving that process termination and exit code reporting over ConPTY and Named Pipe IPC function as intended.
3. **Contract Adherence (Observation 1 & 3)**: `OrcadNativePtyProvider.writeWithSettlement` conforms to `WriteSettlement` by returning `WRITE_ACCEPTED` or `writeRefused('transport_rejected_before_handoff')` without leaking unexpected properties. `orcad-native-pty-provider.test.ts` validates both active and refused settlement paths.
4. **Zero-Regression Verification (Observations 3, 4, 5)**: All 12 unit and integration tests pass, `pnpm tc` completes with 0 errors, `goal validate` passes with code 0, and `oxlint` detects 0 errors across all modified files.

---

## 3. Caveats

- In Windows environments with custom third-party shells, callers specifying custom execution arguments must pass them via `terminalShellArgs` without setting `command` to avoid triggering the interactive startup shell wrapper. This matches the behavior in `src/main/daemon/pty-subprocess/shell-launch-plan.ts`.
- Full packaging via electron-builder was verified through unit test `config/scripts/electron-builder-native-resources.test.mjs`; packaging artifact creation on CI is validated during release builds.

---

## 4. Conclusion

**Verdict: APPROVE**

The remediation for Milestone 2 is complete, correct, and robust:

- Windows shell argument resolution in `src/main/providers/orcad-pty-spawn-plan.ts` handles `terminalShellArgs` cleanly without hanging on `/K`.
- Workarounds were removed from `src/main/providers/orcad-native-pty-provider.integration.test.ts`, and the test passes against the real native `orcad.exe` binary in 96ms.
- All 12 unit and integration tests, TypeScript typechecking, goal validation, and linting pass with 0 errors.
- No integrity violations or regressions were found.
- Milestone 2 is approved and ready for completion marking in the active Orca goal (`node out/cli/index.js goal complete 3` and `node out/cli/index.js goal complete 4`) and advancement to Milestone 3.

---

## 5. Verification Method

Independent reproduction commands:

```powershell
# 1. Run live integration test against orcad.exe
pnpm test src/main/providers/orcad-native-pty-provider.integration.test.ts

# 2. Run unit tests
pnpm test src/main/providers/orcad-native-pty-provider.test.ts src/main/daemon/daemon-provider-init.test.ts config/scripts/electron-builder-native-resources.test.mjs

# 3. Typecheck
pnpm tc

# 4. Goal validation
node out/cli/index.js goal validate

# 5. Lint
npx oxlint src/main/providers/orcad-native-pty-provider.ts src/main/providers/orcad-pty-spawn-plan.ts src/main/providers/orcad-native-pty-provider.test.ts src/main/providers/orcad-native-pty-provider.integration.test.ts
```

**Invalidation Conditions**:

- Any timeout or exit failure when executing `orcad-native-pty-provider.integration.test.ts`.
- Any reappearance of synthetic keystroke workarounds (such as writing `'exit\r\n'`) to terminate `/c` execution.
- Any non-zero exit code from `pnpm tc` or `node out/cli/index.js goal validate`.
