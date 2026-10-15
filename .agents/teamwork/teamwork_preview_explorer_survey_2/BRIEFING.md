# BRIEFING — 2026-10-12T17:21:00Z

## Mission

Perform comprehensive technical survey of Electron/TypeScript terminal and IPC layer in main vs MIgration worktree.

## 🔒 My Identity

- Archetype: explorer
- Roles: investigation, synthesis
- Working directory: C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\teamwork_preview_explorer_survey_2
- Original parent: f6a3f2e3-2858-4e06-a899-3b302da57ca2
- Milestone: survey

## 🔒 Key Constraints

- Read-only investigation — do NOT implement
- Do not modify or create source code files outside working directory
- Never place source code or tests in .agents/teamwork
- Worktree safety: compare main with MIgration worktree

## Current Parent

- Conversation ID: f6a3f2e3-2858-4e06-a899-3b302da57ca2
- Updated: 2026-10-12T17:21:00Z

## Investigation State

- **Explored paths**:
  - `src/main/providers/pty-provider-contract.ts` & `types.ts`
  - `src/main/ipc/pty/provider/registry.ts`, `bind-listeners.ts`, `session.ts`, `delivery/*`
  - `src/main/daemon/daemon-provider-init.ts`, `daemon-provider-state.ts`, `daemon-spawner.ts`, `daemon-client-ndjson-readers.ts`
  - `src/preload/api/pty-api.ts` & `src/renderer`
  - `MIgration/src/main/providers/orcad-native-pty-client.ts`, `orcad-native-pty-provider.ts`, `orcad-pty-spawn-plan.ts`
  - `MIgration/crates/orca-protocol`, `orca-pty`, `orcad`, `orca-cli`
  - `MIgration/config/electron-builder.config.cjs`, `packaged-native-binaries.cjs`
  - `MIgration/tests/tools/benchmarks/rust-phase1-performance-bench.mjs`, `tests/e2e/orcad-native-terminal-live.spec.ts`
- **Key findings**:
  - `IPtyProvider` abstraction in `main` enables clean drop-in replacement with `OrcadNativePtyProvider` without touching renderer or preload code.
  - "Orca no responde" freezes are caused by V8 main loop starvation and ConPTY pipe bottlenecks in Node.js.
  - Rust Tokio daemon + Win32 ConPTY dedicated OS reader thread + Job Objects (`KILL_ON_JOB_CLOSE`, no `BREAKAWAY_OK`) completely solves freezes and leaks.
  - Minor gaps in prototype identified: `orcad-native-pty-client.ts` should use `spawnProcess` rather than `node:child_process.spawn`; `OrcadNativePtyProvider` should expose `pauseProducer`/`resumeProducer`.
- **Unexplored areas**: None. Complete survey achieved.

## Key Decisions Made

- Documented full architectural comparison in `survey_electron.md`.
- Formatted 5-component handoff in `handoff.md`.

## Artifact Index

- DISPATCH.md — record of incoming dispatch messages
- BRIEFING.md — persistent working memory
- progress.md — liveness heartbeat
- survey_electron.md — detailed technical survey findings
- handoff.md — 5-component handoff report
