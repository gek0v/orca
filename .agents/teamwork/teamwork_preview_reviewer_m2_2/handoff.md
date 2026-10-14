# Handoff Report: Milestone 2 Review and Adversarial Audit

## 1. Observation

- Inspected the following primary implementation and configuration files:
  - `src/main/daemon/daemon-provider-init.ts`:
    - Lines 41-59: `shouldAdoptNativeOrcadProvider(ctx?)` checks `ORCA_DISABLE_NATIVE_ORCAD === '1'` (precedence over enable), `ORCA_USE_NATIVE_ORCAD === '1'`, context override `hasNativeBinary`, and falls back to `resolveNativeBinary(...)`.
    - Lines 76-91: `initDaemonPtyProvider` wraps `new OrcadNativePtyProvider()` and `await nativeProvider.ensureConnected()` in a `try/catch`. On failure, logs warning `[daemon] Native orcad provider init failed, falling back to legacy spawner:` and proceeds to legacy `DaemonSpawner`.
  - `config/scripts/packaged-native-binaries.cjs`:
    - Lines 4-19: `findNativeBinaryCandidate` checks `dist/bin/${binaryName}` and `target/release/${binaryName}` relative to `projectRoot`.
    - Lines 21-37: `getPackagedNativeBinaryResources` appends `.exe` on Windows (`win32`), scans candidate binaries (`orcad.exe`, and optional CLI `orca.exe`), and returns mapping `{ from: candidate, to: 'bin/' + binary }`.
  - `config/electron-builder.config.cjs`:
    - Lines 41-43: imports `getPackagedNativeBinaryResources`.
    - Lines 152-154: defines `nativeOrcadResource(platform) { return getPackagedNativeBinaryResources(platform, { includeCli: false }) }`.
    - Line 499: spreads `...nativeOrcadResource('win32')` directly into Windows `extraResources`.
  - `package.json`:
    - Line 46: defines `"build:native:rust": "cargo build --release -p orcad"`.
    - Line 120: integrates `"build:win": "pnpm run build:native:rust && pnpm run build:desktop && pnpm run ensure:electron-runtime && electron-builder --config config/electron-builder.config.cjs --win"`.
  - `src/main/providers/orcad-native-pty-client.ts`, `src/main/providers/orcad-native-pty-provider.ts`, and `src/main/providers/orcad-pty-spawn-plan.ts`:
    - Line-delimited JSON-RPC over Node `net.Socket` to `\\.\pipe\orcad-desktop-${process.pid}` (Windows) or `/tmp/orcad-desktop-${process.pid}.sock` (Unix).
    - Spawns daemon if absent via `spawnProcess` with detached mode, unref, and stdio ignore.
    - RPC method parity with `crates/orcad/src/server.rs`: `pty.spawn`, `pty.write`, `pty.resize`, `pausePty`, `resumePty`, `pty.shutdown`, `setSessionBackground`.
    - Broadcast events handling for `data` and `exit`.
- Executed unit and integration test suites:
  1. `pnpm test src/main/daemon/daemon-provider-init.test.ts`:
     ```text
     ✓ bun src/main/daemon/daemon-provider-init.test.ts (3 tests) 6ms
     Test Files  1 passed (1)
          Tests  3 passed (3)
     ```
  2. `pnpm test config/scripts/electron-builder-native-resources.test.mjs`:
     ```text
     ✓ bun config/scripts/electron-builder-native-resources.test.mjs (2 tests) 8ms
     Test Files  1 passed (1)
          Tests  2 passed (2)
     ```
  3. `pnpm test src/main/providers/orcad-native-pty-provider.test.ts`:
     ```text
     ✓ bun src/main/providers/orcad-native-pty-provider.test.ts (2 tests) 77ms
     Test Files  1 passed (1)
          Tests  2 passed (2)
     ```
- Executed typecheck validation:
  - `pnpm tc` exited with code 0 (all projects cleanly typechecked in parallel).
- Verified Orca Goal status:
  - `node out/cli/index.js goal status` outputs:
    - `[x] 1. Portar e integrar crates/orcad, crates/orca-pty, crates/orca-protocol y Cargo.toml/Cargo.lock desde MIgration`
    - `[x] 2. Verificar compilacion limpia de crates en Windows con cargo check y cargo test`
    - `[x] 3. Conectar IPC de Electron (named pipes) al daemon orcad para delegar gestion y streaming de PTYs`
    - `[x] 4. Actualizar scripts de empaquetado para incluir orcad.exe en la distribucion de Windows`
    - `[ ] 5. Validar reactividad y fluidez de terminales en Windows sin bloqueos de UI (pnpm tc y pruebas de integracion)`

## 2. Logic Chain

1. `shouldAdoptNativeOrcadProvider` was verified through both static inspection and vitest execution. When `ORCA_DISABLE_NATIVE_ORCAD=1` is set, adoption is immediately rejected regardless of binary presence or force flags. When the binary is present and not disabled, native adoption is selected.
2. If `OrcadNativePtyProvider.ensureConnected()` fails to establish IPC connectivity, the exception is caught in `initDaemonPtyProvider`, logging a milestone warning and seamlessly falling back to the legacy `DaemonSpawner`.
3. In `config/electron-builder.config.cjs`, `nativeOrcadResource('win32')` returns the mapped candidate for `orcad.exe`, directing electron-builder to copy `target/release/orcad.exe` into `resources/bin/orcad.exe`. At runtime, `resolveNativeBinary` in `orcad-local-serve-selection.ts` locates this under `process.resourcesPath/bin/orcad.exe`, maintaining runtime parity.
4. Build chaining in `package.json` guarantees that `cargo build --release -p orcad` executes prior to electron-builder execution on Windows (`build:win`), ensuring the binary exists prior to packaging.
5. All test suites pass without regression, and `pnpm tc` completes with 0 errors.

## 3. Caveats

- End-to-end UI reactivity under continuous high-volume terminal output ("Orca no responde" freeze stress test) is scoped to Milestone 3 as defined in `PROJECT.md` and `ORIGINAL_REQUEST.md`.

## 4. Conclusion

Milestone 2 implementation is robust, correct, compliant with `AGENTS.md` and `PROJECT.md` specifications, and free of integrity violations. Verdict is **APPROVE**.

## 5. Verification Method

To independently verify:

```bash
# 1. Run daemon provider init unit tests:
pnpm test src/main/daemon/daemon-provider-init.test.ts

# 2. Run packaging resources test:
pnpm test config/scripts/electron-builder-native-resources.test.mjs

# 3. Run IPC native PTY provider test:
pnpm test src/main/providers/orcad-native-pty-provider.test.ts

# 4. Run TypeScript checks:
pnpm tc

# 5. Check goal status:
node out/cli/index.js goal status
```

Invalidation conditions: Any failure in the above tests, non-zero exit code from `pnpm tc`, or missing `orcad.exe` mapping in `getPackagedNativeBinaryResources('win32')`.

---

## Review Report

**Verdict**: APPROVE

### Integrity Verification Check

- [x] No hardcoded test results or expected outputs embedded in source code.
- [x] No dummy or facade implementations; full IPC client, provider, spawn plan, and Rust RPC handlers exist.
- [x] No shortcuts bypassing the core task.
- [x] No fabricated verification outputs; all tests independently reproduced.
- [x] Genuine independent verification completed.

### Findings

#### [Minor] Finding 1: Unhandled Native Provider Dispose on Failed Initialization

- **What**: In `src/main/daemon/daemon-provider-init.ts`, if `nativeProvider.ensureConnected()` throws an error, the `catch` block logs a warning and falls back to legacy `DaemonSpawner`, but does not call `nativeProvider.dispose()`.
- **Where**: `src/main/daemon/daemon-provider-init.ts:77-90`
- **Why**: If `OrcadNativePtyClient` spawned a detached `orcad.exe` process before the socket connection failed/timed out, that child process remains running unmanaged.
- **Suggestion**: Add `try { nativeProvider.dispose() } catch {}` in the catch block to clean up any spawned process before falling back.

#### [Minor] Finding 2: Packaging Candidate Absence Fail-Open

- **What**: `config/scripts/packaged-native-binaries.cjs` returns an empty array if `target/release/orcad.exe` does not exist on disk.
- **Where**: `config/scripts/packaged-native-binaries.cjs:28-34`
- **Why**: While `package.json`'s `build:win` script builds the native binary first, direct invocation of `electron-builder --win` would produce an installer omitting `orcad.exe` without failing.
- **Suggestion**: For release builds on Windows (`isWinRelease`), consider asserting that `orcad.exe` was found rather than silently returning an empty array.

### Verified Claims

- `shouldAdoptNativeOrcadProvider` respects `ORCA_DISABLE_NATIVE_ORCAD` → verified via `pnpm test src/main/daemon/daemon-provider-init.test.ts` → PASS
- Windows electron-builder includes `orcad.exe` in `extraResources` under `bin/orcad.exe` → verified via `pnpm test config/scripts/electron-builder-native-resources.test.mjs` → PASS
- Full PTY lifecycle (spawn, write, resize, pause, resume, shutdown) over named pipe IPC → verified via `pnpm test src/main/providers/orcad-native-pty-provider.test.ts` → PASS
- Clean TypeScript types across workspace → verified via `pnpm tc` → PASS

### Coverage Gaps

- None for Milestone 2 scope. Real Chromium UI reactivity under terminal load is deferred to Milestone 3.

### Unverified Items

- None.

---

## Adversarial Challenge Report

**Overall risk assessment**: LOW

### Challenges

#### [Low] Challenge 1: Connection Race on Slow Windows Machine

- **Assumption challenged**: Spawning `orcad.exe` and connecting to `\\.\pipe\orcad-desktop-${pid}` within 30 retries × 50ms (1.5 seconds) is always sufficient.
- **Attack scenario**: Under heavy system load or slow antivirus scanning of newly spawned `orcad.exe`, the named pipe listener may take longer than 1.5s to initialize.
- **Blast radius**: `OrcadNativePtyClient` times out, falling back gracefully to legacy `DaemonSpawner`. No crash occurs, but native acceleration is bypassed for that session.
- **Mitigation**: Fallback mechanism works as intended; if needed in production, retry duration can be adjusted or configured via environment variable.

#### [Low] Challenge 2: Accidental Concurrent Pipe Name Collision

- **Assumption challenged**: `\\.\pipe\orcad-desktop-${process.pid}` is uniquely scoped to the running Electron main process.
- **Attack scenario**: PID collision across rapid reboots or multi-instance containers.
- **Blast radius**: If another process owns the pipe, connection either fails or talks to conflicting daemon.
- **Mitigation**: `crates/orcad/src/ipc.rs` handles named pipe instances (`ServerOptions::new().first_pipe_instance(...)`), and Electron process PIDs are OS-unique during session lifetimes.

### Stress Test Results

- Discovery with native binary present → returns `true` → PASS
- Discovery with native binary present + `ORCA_DISABLE_NATIVE_ORCAD=1` → returns `false` → PASS
- Discovery with native binary absent + `ORCA_USE_NATIVE_ORCAD=1` → returns `true` → PASS
- Packaging with Windows platform → includes `bin/orcad.exe` in `extraResources` → PASS
- Non-Windows packaging resolution → includes `bin/orcad` and `bin/orca` → PASS
