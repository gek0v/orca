# Handoff Report: Survey of Packaging, Build Scripts, Goals, and Verification

**Agent:** survey_explorer_3  
**Working Directory:** `C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\teamwork_preview_explorer_survey_3`  
**Handoff Type:** Hard (Task Complete)

---

## 1. Observation

1. **`config/electron-builder.config.cjs` in `main` vs `MIgration`**:
   - In `main` (lines 489–510), `win.extraResources` packages:
     ```javascript
     extraResources: [
       ...commonExtraResources,
       ...windowsRuntimeResources,
       winSpeechNativeResource,
       { from: 'resources/win32/bin/orca.cmd', to: 'bin/orca.cmd' },
       { from: 'native/windows-cli-launcher/.build/orca.exe', to: 'bin/orca.exe' },
       {
         from: 'node_modules/agent-browser/bin/agent-browser-win32-x64.exe',
         to: 'agent-browser-win32-x64.exe'
       },
       { from: 'native/computer-use-windows/runtime.ps1', to: 'computer-use-windows/runtime.ps1' },
       featureWallResources
     ]
     ```
   - In `MIgration` (commit `a2248ca26c`), `config/scripts/packaged-native-binaries.cjs` is introduced and used via:
     ```javascript
     const { getPackagedNativeBinaryResources } = require('./scripts/packaged-native-binaries.cjs')
     function nativeOrcadResource(platform) {
       return getPackagedNativeBinaryResources(platform, { includeCli: false })
     }
     ```
     and inserted into `win.extraResources`:
     ```javascript
     extraResources: [
       ...commonExtraResources,
       ...windowsRuntimeResources,
       winSpeechNativeResource,
       ...nativeOrcadResource('win32'),
       ...
     ]
     ```
   - `packaged-native-binaries.cjs` inspects `dist/bin/orcad.exe` and `target/release/orcad.exe`, mapping them to `to: 'bin/orcad.exe'` in the packaged app resources folder.

2. **Binary Resolution at Runtime (`orcad.exe`)**:
   - `src/main/orcad/orcad-local-serve-selection.ts` lines 54–82 (`resolveNativeBinary`):
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
         if (existsSync(candidate)) return candidate
       }
     }
     ```
   - In development, `process.cwd()` is `C:\Users\Geko\orca\workspaces\orca-upstream\main`, resolving `target/release/orcad.exe`.
   - In packaged mode, `process.resourcesPath` is `<install>/resources`, resolving `resources/bin/orcad.exe`.

3. **Active Goal and CLI Validation**:
   - `.orca/goals.json` contains active goal `goal-1791824736032` with validation command `"pnpm tc"`.
   - Command `node out/cli/index.js goal status` successfully parsed and printed all 5 subtasks with exit code 0.
   - Command `node out/cli/index.js goal validate` ran `pnpm tc` via `GoalsValidationRunner`, exited with code 0, updated `.orca/last_validation.log`, and updated `.orca/CURRENT_GOAL.md` to:
     ```text
     ## Validación Técnica
     - Comando: `pnpm tc`
     - Estado: Exitoso
     ```
   - Command `node out/cli/index.js goal complete <id-or-index>` accepts a 1-based index (e.g. `1`) or subtask ID (e.g. `task-1791824743342`), marking the task completed and projecting `.orca/CURRENT_GOAL.md`.

4. **Typecheck & Rust Test Verification**:
   - Command `pnpm tc` ran via `config/scripts/run-typecheck-projects-in-parallel.mjs` and passed with code 0.
   - Command `cargo check -p orcad -p orca-pty -p orca-protocol` in `MIgration` completed in 0.23s with code 0.
   - Command `cargo test -p orcad -p orca-pty` in `MIgration` completed with code 0, executing 96 tests across unit, IPC, adversarial, and stress suites without any failures.

---

## 2. Logic Chain

1. From **Observation 1**, `main` does not yet package `orcad.exe`, but `MIgration` established a clean helper `packaged-native-binaries.cjs` that detects `target/release/orcad.exe` and maps it into `bin/orcad.exe` under Electron resources. Porting this file and adding `...nativeOrcadResource('win32')` to `config/electron-builder.config.cjs` satisfies Requirement R4.
2. From **Observation 2**, the runtime binary resolution logic in `resolveNativeBinary` checks `process.cwd()/target/release/orcad.exe` in development and `process.resourcesPath/bin/orcad.exe` in production. Thus, compiling with `cargo build --release -p orcad` satisfies development execution without copying, while `electron-builder` copies it to `resources/bin/orcad.exe` for packaged distribution.
3. From **Observation 3**, the tracking system in `.orca/goals.json` and `.orca/CURRENT_GOAL.md` responds to `node out/cli/index.js goal complete <1-5>` and `node out/cli/index.js goal validate`. Because `validate` runs `pnpm tc`, any TypeScript regressions will immediately flag as failed in the goal status.
4. From **Observation 4**, the Rust codebase in `MIgration` is already verified clean on Windows (96/96 tests passing). Porting `Cargo.toml`, `Cargo.lock`, `crates/orcad`, `crates/orca-pty`, and `crates/orca-protocol` into `main` will compile cleanly and provide the required `orcad.exe` binary.

---

## 3. Caveats

- **`orca-desktop` Crate**: `MIgration` contains a Tauri-based `orca-desktop` crate and `orca-cli` crate. Per `ORIGINAL_REQUEST.md`, Electron is maintained as the desktop shell (`"manteniendo Electron como shell de escritorio"`). Therefore, `orca-desktop` should **not** be integrated into `main`'s workspace or build pipeline.
- **Cargo.lock compatibility**: When copying `Cargo.toml` and `Cargo.lock` from `MIgration` to `main`, ensure members list only the crates being ported (`crates/orcad`, `crates/orca-pty`, `crates/orca-protocol`).
- **Build time on `build:win`**: Running `cargo build --release -p orcad` as part of `build:win` adds standard Rust incremental compilation time (~1-3 seconds on warm cache, ~1-2 minutes on cold cache).

---

## 4. Conclusion

The build, packaging, goal tracking, and test infrastructure are completely understood and verified.

- **Packaging**: Ready to be enabled via `packaged-native-binaries.cjs` and `config/electron-builder.config.cjs`.
- **Build script**: A `build:native:rust` script (`cargo build --release -p orcad`) should be added to `package.json` and linked into `build:win`.
- **Goal tracking**: Goal ID `goal-1791824736032` is active and ready to be progressed using `node out/cli/index.js goal complete <index>`.
- **Validation**: `node out/cli/index.js goal validate` is operational and currently green.

---

## 5. Verification Method

To verify these findings independently:

1. **Verify Goal Status & CLI**:

   ```powershell
   node out/cli/index.js goal status
   node out/cli/index.js goal validate
   ```

   Check that validation passes with exit code 0 and updates `.orca/CURRENT_GOAL.md`.

2. **Verify Rust Test Suite in MIgration**:

   ```powershell
   cd C:\Users\Geko\orca\workspaces\orca-upstream\MIgration
   cargo test -p orcad -p orca-pty
   ```

   Verify 96 tests pass without error.

3. **Verify Typecheck in main**:

   ```powershell
   cd C:\Users\Geko\orca\workspaces\orca-upstream\main
   pnpm tc
   ```

   Verify exit code 0.

4. **Inspect Documentation**:
   Read `C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\teamwork_preview_explorer_survey_3\survey_packaging.md`.
