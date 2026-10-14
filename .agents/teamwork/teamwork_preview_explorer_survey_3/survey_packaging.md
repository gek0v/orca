# Technical Survey: Packaging, Build Scripts, Goal Status, and Verification

**Date:** 2026-10-12  
**Author:** survey_explorer_3  
**Target:** Orca Daemon Rust Integration (MIgration → main)

---

## Executive Summary

This report delivers a technical survey of the packaging configurations, build scripts, goal status tracking, and verification mechanisms required to integrate the Rust-migrated Orca daemon (`orcad`, `orca-pty`, `orca-protocol`) from the `MIgration` worktree into `main`.

Key discoveries:

1. **Packaging Mechanism**: `MIgration` implements a clean native binary packaging pattern using `config/scripts/packaged-native-binaries.cjs`. This utility inspects `target/release/orcad.exe` (or `dist/bin/orcad.exe`) and maps it into `bin/orcad.exe` in `extraResources` for Electron Builder.
2. **Binary Resolution**: In dev mode, `resolveNativeBinary()` locates `target/release/orcad.exe` directly under `process.cwd()`. In packaged mode, it locates `join(process.resourcesPath, 'bin', 'orcad.exe')`.
3. **Goal Tracking & Validation CLI**: The active goal (`goal-1791824736032`) contains 5 sequential subtasks. The CLI (`node out/cli/index.js goal complete <id-or-index>` and `node out/cli/index.js goal validate`) is fully functional. `goal validate` invokes `pnpm tc` via `GoalsValidationRunner`, persists full logs to `.orca/last_validation.log`, and synchronizes `.orca/CURRENT_GOAL.md`.
4. **Verification & Testing Status**: `pnpm tc` passes cleanly in `main`. In `MIgration`, `cargo check` and `cargo test -p orcad -p orca-pty` pass with 96 passed tests (0 failures) natively on Windows.

---

## 1. Build & Packaging Architecture

### 1.1 `config/electron-builder.config.cjs`

#### Current State in `main`:

- Defines packaging for Windows (`win:`), macOS (`mac:`), and Linux (`linux:`).
- `win.extraResources` contains:
  - `resources/win32/bin/orca.cmd` → `bin/orca.cmd`
  - `native/windows-cli-launcher/.build/orca.exe` → `bin/orca.exe`
  - `agent-browser-win32-x64.exe`
  - `native/computer-use-windows/runtime.ps1`
  - `commonExtraResources` (relay, orcad template, bundled ripgrep, plugins, skills, emoji data)
  - `windowsRuntimeResources` (`@vscode/windows-process-tree`)
  - `winSpeechNativeResource`
- Does **not** include the native Rust daemon binary `orcad.exe`.

#### Implementation in `MIgration`:

In `MIgration` (commit `a2248ca26c`), the following pattern is established:

1. A new helper module `config/scripts/packaged-native-binaries.cjs` is imported:
   ```javascript
   const { getPackagedNativeBinaryResources } = require('./scripts/packaged-native-binaries.cjs')
   ```
2. A helper function wraps platform resource mapping:
   ```javascript
   function nativeOrcadResource(platform) {
     return getPackagedNativeBinaryResources(platform, { includeCli: false })
   }
   ```
3. Added to `win.extraResources`:
   ```javascript
   extraResources: [
     ...commonExtraResources,
     ...windowsRuntimeResources,
     winSpeechNativeResource,
     ...nativeOrcadResource('win32'),
     ...
   ]
   ```
   _(And symmetrically for `darwin` and `linux`)._

#### Details of `config/scripts/packaged-native-binaries.cjs`:

- Searches candidate locations:
  1. `join(projectRoot, 'dist', 'bin', binaryName)`
  2. `join(projectRoot, 'target', 'release', binaryName)`
- For Windows, evaluates `orcad.exe`. When present, returns:
  ```javascript
  {
    from: '<absolute_or_relative_path_to_orcad.exe>',
    to: 'bin/orcad.exe'
  }
  ```
- Because electron-builder places `extraResources` inside `<appRoot>/resources/`, the packaged binary is located at `resources/bin/orcad.exe`.

### 1.2 `package.json` Scripts

#### Comparison of Relevant Scripts:

| Script Name         | `main`                                                                                                                                                                                                  | `MIgration`                                                  | Purpose                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `build:win`         | `pnpm run build:desktop && pnpm run ensure:electron-runtime && electron-builder --config config/electron-builder.config.cjs --win`                                                                      | Same                                                         | Packages Windows NSIS installer and unpacked directory                    |
| `build:desktop`     | `pnpm run typecheck && pnpm run build:relay && pnpm run build:cli && pnpm run build:electron-vite && pnpm run verify:built-skills-cli && pnpm run build:web-from-renderer && pnpm run build:mobile-web` | Same                                                         | Assembles desktop web, renderer, CLI, and relay bundles                   |
| `build:native`      | `node config/scripts/build-native-for-platform.mjs`                                                                                                                                                     | Same                                                         | Builds native modules (on Windows, runs `build-windows-cli-launcher.mjs`) |
| `build:native:rust` | _Absent_                                                                                                                                                                                                | `cargo build --release -p orcad -p orca-cli -p orca-desktop` | Compiles Rust workspace binaries in release mode                          |
| `build:orcad`       | `node config/scripts/build-orcad-node.mjs`                                                                                                                                                              | Same                                                         | Legacy Node.js orcad bundle script                                        |

#### Packaging Build Script Integration Recommendation:

To satisfy Requirement R4 ("el binario de orcad se compile e incluya automáticamente dentro de los recursos de distribución en build:win"):

1. Add script in `package.json`:
   ```json
   "build:native:rust": "cargo build --release -p orcad"
   ```
2. Chain `build:native:rust` into `build:win` (or as a prerequisite in `build:desktop` / `build:native`):
   ```json
   "build:win": "pnpm run build:native:rust && pnpm run build:desktop && pnpm run ensure:electron-runtime && electron-builder --config config/electron-builder.config.cjs --win"
   ```

### 1.3 Cargo / Rust Workspace Configuration

- `main` currently does not have a top-level `Cargo.toml` or `Cargo.lock` (only `native/windows-cli-launcher/Cargo.toml` exists).
- `MIgration` provides:
  - Root `Cargo.toml`:
    ```toml
    [workspace]
    members = [
        "crates/orca-protocol",
        "crates/orca-pty",
        "crates/orcad",
        "crates/orca-cli",
        "crates/orca-desktop",
    ]
    resolver = "2"

    [workspace.package]
    version = "1.4.214"
    edition = "2021"
    authors = ["Orca Team"]
    license = "MIT"

    [workspace.dependencies]
    serde = { version = "1.0", features = ["derive"] }
    serde_json = "1.0"
    bytes = "1.10"
    tokio = { version = "1.43", features = ["full"] }
    thiserror = "2.0"
    tracing = "0.1"
    tracing-subscriber = { version = "0.3", features = ["env-filter"] }
    clap = { version = "4.5", features = ["derive"] }
    futures = "0.3"
    async-trait = "0.1"
    ```
  - For `main`, because Electron remains the desktop shell, the required members are:
    `"crates/orca-protocol"`, `"crates/orca-pty"`, `"crates/orcad"`.
  - Windows specific dependencies configured:
    - In `crates/orcad`: `windows = { version = "0.59", features = ["Win32_System_ProcessStatus", "Win32_System_Threading"] }`
    - In `crates/orca-pty`: `windows = { version = "0.59", features = ["Win32_Foundation", "Win32_System_Console", "Win32_System_Threading", "Win32_System_JobObjects", "Win32_Security", "Win32_Storage_FileSystem", "Win32_System_Pipes", "Win32_System_IO"] }`

### 1.4 Binary Resolution Location (`orcad.exe`)

The resolution logic in `src/main/orcad/orcad-local-serve-selection.ts` (`resolveNativeBinary`) operates as follows:

```typescript
const binaryName = input.platform === 'win32' ? 'orcad.exe' : 'orcad'
const roots = [
  input.appRoot,
  process.cwd(),
  ...(process.resourcesPath ? [process.resourcesPath] : [])
].filter((p): p is string => typeof p === 'string' && p.length > 0)

for (const root of roots) {
  const candidates = [
    join(root, 'bin', binaryName),
    join(root, 'dist', 'bin', binaryName),
    join(root, 'target', 'release', binaryName)
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
}
```

#### Binary Location Matrix:

| Environment                                   | Discovery Path                                                                           | How it gets there                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Development** (`pnpm dev`, `vitest`)        | `C:\Users\Geko\orca\workspaces\orca-upstream\main\target\release\orcad.exe`              | Produced directly by `cargo build --release -p orcad`                             |
| **Development Override**                      | Path specified in env `ORCAD_NATIVE_BIN` or `ORCAD_BIN`                                  | Set by developer/script                                                           |
| **Packaged App** (`build:win` / NSIS install) | `<installDir>\resources\bin\orcad.exe` (i.e. `process.resourcesPath + '/bin/orcad.exe'`) | Copied from `target/release/orcad.exe` by `electron-builder` via `extraResources` |

---

## 2. Active Goal & Validation Mechanisms

### 2.1 State in `.orca/goals.json` and `.orca/CURRENT_GOAL.md`

- **Active Goal ID**: `goal-1791824736032`
- **Title**: `Integrar daemon en Rust (orcad) de MIgration a main`
- **Description**: `Portar crates/orcad, crates/orca-pty y crates/orca-protocol para delegar la gestion de terminales en Windows mediante ConPTY nativo y resolver cuelgues`
- **Validation Command**: `pnpm tc`
- **Subtasks Overview**:

| Subtask ID           | 1-based Index | Title                                                                                                         | Status     |
| -------------------- | ------------- | ------------------------------------------------------------------------------------------------------------- | ---------- |
| `task-1791824743342` | 1             | Portar e integrar crates/orcad, crates/orca-pty, crates/orca-protocol y Cargo.toml/Cargo.lock desde MIgration | Incomplete |
| `task-1791824748794` | 2             | Verificar compilacion limpia de crates en Windows con cargo check y cargo test                                | Incomplete |
| `task-1791824755257` | 3             | Conectar IPC de Electron (named pipes) al daemon orcad para delegar gestion y streaming de PTYs               | Incomplete |
| `task-1791824761613` | 4             | Actualizar scripts de empaquetado para incluir orcad.exe en la distribucion de Windows                        | Incomplete |
| `task-1791824768834` | 5             | Validar reactividad y fluidez de terminales en Windows sin bloqueos de UI (pnpm tc y pruebas de integracion)  | Incomplete |

### 2.2 CLI Operations

Both commands are dispatched by `src/cli/goals-dispatch.ts`:

#### Marking Tasks Complete:

```powershell
node out/cli/index.js goal complete <id-or-index>
```

- Accepts either the 1-based numerical index (e.g. `node out/cli/index.js goal complete 1`) or the task ID string (e.g. `node out/cli/index.js goal complete task-1791824743342`).
- Updates `completed: true` in `.orca/goals.json`.
- Calls `service.projectCurrentGoalFile()` to immediately rewrite `.orca/CURRENT_GOAL.md` with marked checkbox `[x]`.
- Verified working and tested with `goal status`.

#### Validating the Goal:

```powershell
node out/cli/index.js goal validate
```

- Spawns `cmd.exe /d /s /c pnpm tc` in the repository root using `GoalsValidationRunner`.
- Sets a 300,000 ms timeout with `terminationBarrier: true`.
- Captures full stdout and stderr, writing it to `.orca/last_validation.log`.
- Computes `summaryTail` (last 10 non-empty lines, capped at 500 characters).
- Records `exitCode`, updates `status` (`'success'` on exit code 0, `'failed'` otherwise), and refreshes `.orca/CURRENT_GOAL.md`.
- Verified live: exited with code 0 (`Validation Passed (exit code 0): pnpm tc`).

---

## 3. Typecheck, Linting, and Test Runners

### 3.1 Typecheck (`pnpm tc`)

- Script: `pnpm tc` → `pnpm run typecheck` → `node config/scripts/run-typecheck-projects-in-parallel.mjs`.
- Strategy:
  - Divides project typechecking into 3 batches to respect memory budgets:
    1. `config/tsconfig.node.json` (budget: 7 GiB)
    2. `config/tsconfig.tc.web.json` (budget: 6 GiB)
    3. `config/tsconfig.tc.cli.json` (budget: 2 GiB)
  - Schedules batches based on `totalmem()` and `availableParallelism()`.
  - Runs `tsc --noEmit` on each configuration.
- Status: **Passing** (exit code 0).

### 3.2 Linting & Code Quality Gates

- `oxlint`: Primary fast linter.
- `pnpm run check:code-quality:changed`: Checks changed files for design system, type assertions, and style guide rules.
- Key invariants enforced:
  - **No `max-lines` disables**: Never add `eslint-disable max-lines` or `oxlint-disable max-lines`.
  - **Checked types**: Avoid unchecked type assertions; any required cast needs `// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ...`.
  - **Design system tokens**: UI components must strictly use tokens from `src/renderer/src/assets/main.css`.

### 3.3 Test Runners and Integration Tests

#### Cargo Test Suite (Rust):

- Command: `cargo test -p orcad -p orca-pty`
- Status in `MIgration`:
  - 13 unit tests in `crates/orcad/src/lib.rs` (passed)
  - 1 unit test in `crates/orcad/src/main.rs` (passed)
  - 11 adversarial stress tests in `adversarial_stress_tests.rs` (passed)
  - 2 agent status store tests in `agent_status_store_test.rs` (passed)
  - 13 challenger boundary stress tests in `challenger_boundary_stress_test.rs` (passed)
  - 8 daemon IPC tests in `daemon_ipc_test.rs` (passed)
  - 17 E2E migration tests in `e2e_migration_tests.rs` (passed)
  - 10 git streaming tests in `git_streaming_test.rs` (passed)
  - 1 hook server test in `hook_server_test.rs` (passed)
  - 12 relay supervision tests in `relay_supervision_test.rs` (passed)
  - 7 websocket IPC tests in `websocket_ipc_test.rs` (passed)
  - 1 worktree git engine test in `worktree_git_engine_test.rs` (passed)
  - Total: **96 tests passing on Windows**.

#### TypeScript Vitest Suite:

- Runner: `pnpm test [path/to/test]` (uses `config/vitest.config.ts`).
- Key daemon & terminal integration test files to migrate and verify:
  1. `src/main/providers/orcad-native-pty-provider.test.ts`:
     - Creates a mock Named Pipe server (`\\.\pipe\orcad-test-...`) and tests ping, spawn (`cmd.exe`), input writing, resizing, and shutdown.
  2. `src/main/providers/orcad-native-pty-provider.integration.test.ts`:
     - End-to-end test connecting to a live running `orcad.exe` daemon over named pipes.
  3. `src/main/daemon/daemon-provider-init.test.ts`:
     - Tests runtime activation of native orcad provider when `orcad.exe` exists, and graceful fallback to legacy node-pty when absent.
  4. `config/scripts/electron-builder-native-resources.test.mjs`:
     - Verifies `getPackagedNativeBinaryResources('win32')` includes `bin/orcad.exe`.

---

## 4. Implementation Recommendations for Downstream Agents

1. **Root Cargo Setup (Subtask 1)**:
   - Copy `Cargo.toml` and `Cargo.lock` from `MIgration` to `main`.
   - Copy `crates/orcad`, `crates/orca-pty`, and `crates/orca-protocol` to `main/crates/`.
   - Remove `crates/orca-desktop` and `crates/orca-cli` from `members` if only the daemon crates are targeted, or include them if clean compilation is preserved.
2. **Rust Verification (Subtask 2)**:
   - Execute `cargo check -p orcad -p orca-pty -p orca-protocol`.
   - Execute `cargo test -p orcad -p orca-pty`.
   - Execute `cargo build --release -p orcad` to generate `target/release/orcad.exe`.
3. **IPC Connection (Subtask 3)**:
   - Port `src/main/providers/orcad-native-pty-client.ts`, `src/main/providers/orcad-native-pty-provider.ts`, and `src/main/providers/orcad-pty-spawn-plan.ts`.
   - Update `src/main/daemon/daemon-provider-init.ts` to instantiate `OrcadNativePtyProvider` on Windows.
4. **Packaging Setup (Subtask 4)**:
   - Copy `config/scripts/packaged-native-binaries.cjs` and `config/scripts/electron-builder-native-resources.test.mjs`.
   - Update `config/electron-builder.config.cjs` to include `...nativeOrcadResource('win32')` in `win.extraResources`.
   - Update `package.json` to add `"build:native:rust"` and include it in `"build:win"`.
5. **Validation and Subtask Completion (Subtask 5)**:
   - After each subtask, invoke `node out/cli/index.js goal complete <index>`.
   - Run `node out/cli/index.js goal validate` to ensure `pnpm tc` remains green throughout.
