# BRIEFING — 2026-10-12T18:35:00Z

## Mission

Investigate remediation for the Milestone 2 Forensic Audit failure in Orcad integration test (`connects to real compiled orcad.exe binary and executes a command` timeout waiting for PTY exit).

## 🔒 My Identity

- Archetype: explorer
- Roles: [investigation, synthesis]
- Working directory: C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\teamwork_preview_explorer_m2_fix_2
- Original parent: 3bf2556b-18ec-459f-b6a8-6d9332ac2a12
- Milestone: Milestone 2 Remediation

## 🔒 Key Constraints

- Read-only investigation — do NOT implement
- Cross-platform and worktree safety
- Orcad PTY integration test investigation

## Current Parent

- Conversation ID: 3bf2556b-18ec-459f-b6a8-6d9332ac2a12
- Updated: 2026-10-12T18:24:04Z

## Investigation State

- **Explored paths**:
  - `src/main/providers/orcad-native-pty-provider.integration.test.ts`
  - `src/main/providers/orcad-pty-spawn-plan.ts`
  - `src/main/providers/windows-shell-args.ts`
  - `crates/orca-pty/src/windows.rs`
  - `crates/orcad/src/server.rs`
  - `teamwork_preview_auditor_m2_1/handoff.md`
  - `teamwork_preview_challenger_m2_1/BRIEFING.md`
- **Key findings**:
  1. `buildOrcadPtySpawnPlan` on Windows prepends `resolved.shellArgs` (`['/K', 'chcp 65001 > nul']`) before appending `opts.terminalShellArgs`.
  2. For `cmd.exe`, this creates `cmd.exe /K chcp 65001 > nul /c echo NATIVE_ORCAD_LIVE_SUCCESS`. `/K` prevents `cmd.exe` from exiting, causing `exitPromise` to time out after 5000ms.
  3. In addition, `chcp` receives `/c` and errors with `Formato de parámetro incorrecto: /c`; `echo` is never actually executed.
  4. Challenger's addition of `provider.write(spawnRes.id, 'exit\r\n')` was a brittle workaround; string matched only in OSC 0 window title.
  5. The true fix is in `orcad-pty-spawn-plan.ts`: when `opts.terminalShellArgs` is supplied, use `[...opts.terminalShellArgs]` directly instead of appending after `/K`.
- **Unexplored areas**: None. Root cause identified with full empirical reproduction and exact fix formulated.

## Key Decisions Made

- Confirmed root cause through empirical test scripts.
- Formulated exact two-part fix strategy for `orcad-pty-spawn-plan.ts` and `orcad-native-pty-provider.integration.test.ts`.

## Artifact Index

- DISPATCH.md — record of incoming dispatch messages
- BRIEFING.md — persistent working memory
- progress.md — liveness heartbeat
- handoff.md — 5-component handoff report
