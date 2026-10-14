## 2026-10-12T17:39:51Z

You are worker_m2.
Your working directory: C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\teamwork_preview_worker_m2
Project root directory: C:\Users\Geko\orca\workspaces\orca-upstream\main

Mandatory reading:

1. C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\ORIGINAL_REQUEST.md
2. C:\Users\Geko\orca\workspaces\orca-upstream\main\PROJECT.md
3. C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\teamwork_preview_explorer_survey_2\survey_electron.md
4. C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\teamwork_preview_explorer_survey_2\handoff.md
5. C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\teamwork_preview_explorer_survey_3\survey_packaging.md
6. C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\teamwork_preview_explorer_survey_3\handoff.md

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Task — Milestone 2: Electron IPC & Packaging Integration
Inspect MIgration (C:\Users\Geko\orca\workspaces\orca-upstream\MIgration) to reference the existing implementation of the provider and packaging files:

1. Electron Providers:
   - Port/implement `src/main/providers/orcad-native-pty-client.ts`
     - CRITICAL RULE from AGENTS.md: Use `spawnProcess` from `src/shared/child-process/spawn-process` instead of `node:child_process.spawn`.
     - Use Windows Named Pipe (`\\.\pipe\orcad-desktop-${process.pid}` or `\\.\pipe\orcad`) with line-delimited JSON-RPC over `net.connect()`.
     - Map RPC methods correctly: `pty.spawn`, `pty.write`, `pty.resize`, `pty.shutdown` (or `terminal.kill`), `pausePty`, `resumePty`.
     - Use `socket.destroy()` on close to ensure pipe handles are immediately freed.
   - Port/implement `src/main/providers/orcad-native-pty-provider.ts`
     - Implement `IPtyProvider` (`src/main/providers/pty-provider-contract.ts`).
     - Expose `pauseProducer?: (id: string) => void` and `resumeProducer?: (id: string) => void` aliases matching `IPtyProvider`.
   - Port/implement `src/main/providers/orcad-pty-spawn-plan.ts`
   - Port/implement binary resolution in `src/main/orcad/orcad-local-serve-selection.ts` (locates `target/release/orcad.exe` in dev and `resources/bin/orcad.exe` in packaged app).
2. Daemon Spawner Adoption:
   - Update `src/main/daemon/daemon-provider-init.ts` (and any related routing modules if present in MIgration) to adopt `OrcadNativePtyProvider` by default on Windows when `orcad.exe` is available, with graceful fallback to legacy `DaemonSpawner`.
3. Packaging & Build Scripts:
   - Port `config/scripts/packaged-native-binaries.cjs` from MIgration.
   - Update `config/electron-builder.config.cjs` to include `nativeOrcadResource('win32')` in `win.extraResources`.
   - Update `package.json` with `"build:native:rust": "cargo build --release -p orcad"` and chain it into `"build:win"`.
4. Verification:
   - Run `pnpm tc` and verify 0 TypeScript errors.
   - Run provider unit tests (e.g. `pnpm test src/main/providers/orcad-native-pty-provider.test.ts` or add tests from MIgration).
   - Test that `target/release/orcad.exe` is resolved correctly.
5. Goal Updates:
   - Run `node out/cli/index.js goal complete 3`
   - Run `node out/cli/index.js goal complete 4`
   - Verify with `node out/cli/index.js goal status`
6. Deliverables:
   - Write comprehensive report to C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\teamwork_preview_worker_m2\changes.md
   - Write structured handoff report to C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\teamwork_preview_worker_m2\handoff.md
   - Send completion message back to orchestrator_1 (conversation ID: f6a3f2e3-2858-4e06-a899-3b302da57ca2).
