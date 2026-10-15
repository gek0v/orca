# BRIEFING — 2026-10-12T18:46:30Z

## Mission

Implement Milestone 2 remediation fixes for WriteSettlement contract compliance and PTY spawn plan arguments in Orca.

## 🔒 My Identity

- Archetype: worker_m2_remediate
- Roles: implementer, qa, specialist
- Working directory: C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\teamwork_preview_worker_m2_remediate
- Original parent: 3bf2556b-18ec-459f-b6a8-6d9332ac2a12
- Milestone: M2 (Electron IPC & Packaging Integration)

## 🔒 Key Constraints

- DO NOT CHEAT: genuine implementations only, no hardcoded results, no facade logic.
- Follow AGENTS.md rules: no max-lines disables, reuse before reimplementing, cross-platform compatibility, Windows child process and shell args handling.
- Minimal change principle: only modify required files and lines.
- All gates must pass: pnpm tc (0 errors), all targeted tests, node out/cli/index.js goal validate, oxlint.

## Current Parent

- Conversation ID: 3bf2556b-18ec-459f-b6a8-6d9332ac2a12
- Updated: 2026-10-12T18:46:30Z

## Task Summary

- **What to build**:
  1. Fix `src/main/providers/orcad-native-pty-provider.ts` to use canonical `writeRefused` and remove illegal `error` property.
  2. Fix `src/main/providers/orcad-native-pty-provider.test.ts` to assert canonical `writeRefused` and `WRITE_ACCEPTED`.
  3. Fix `src/main/providers/orcad-pty-spawn-plan.ts` on Windows to use `opts.terminalShellArgs` directly when provided without `opts.command`.
  4. Fix `src/main/providers/orcad-native-pty-provider.integration.test.ts` to remove artificial `exit\r\n` workaround.
  5. Run all test suites and verifications.
- **Success criteria**:
  - `pnpm test src/main/providers/orcad-native-pty-provider.test.ts` PASS (6 passed)
  - `pnpm test src/main/providers/orcad-native-pty-provider.integration.test.ts` PASS (1 passed in 97ms, exit 0)
  - `pnpm test src/main/daemon/daemon-provider-init.test.ts` PASS (3 passed)
  - `pnpm test config/scripts/electron-builder-native-resources.test.mjs` PASS (2 passed)
  - `pnpm tc` PASS (exit code 0 across all targets)
  - `node out/cli/index.js goal validate` PASS (exit code 0)
  - `npx oxlint` PASS (0 errors, 0 warnings)
- **Interface contracts**: PROJECT.md, `src/shared/pty-write-settlement.ts`, `src/main/providers/pty-provider-contract.ts`
- **Code layout**: PROJECT.md § Code Layout

## Key Decisions Made

- Used canonical `writeRefused('transport_rejected_before_handoff')` helper factory from `src/shared/pty-write-settlement.ts`.
- Set `args = [...opts.terminalShellArgs]` when supplied without command on Windows so `/K` is not prepended to non-interactive shell commands.
- Removed stale `.js` and `.d.ts` artifacts emitted from prior builds in `src/main/providers/` to ensure Bun/Vitest evaluates up-to-date `.ts` sources directly.

## Artifact Index

- `.agents/teamwork/teamwork_preview_worker_m2_remediate/DISPATCH.md` — Assigned instructions
- `.agents/teamwork/teamwork_preview_worker_m2_remediate/progress.md` — Liveness & progress tracker
- `.agents/teamwork/teamwork_preview_worker_m2_remediate/handoff.md` — Final verification report

## Change Tracker

- **Files modified**:
  - `src/main/providers/orcad-native-pty-provider.ts`: Import `writeRefused`; return `writeRefused('transport_rejected_before_handoff')` in `writeWithSettlement`.
  - `src/main/providers/orcad-native-pty-provider.test.ts`: Import `WRITE_ACCEPTED` and `writeRefused`; assert exact equality for active and dead sessions.
  - `src/main/providers/orcad-pty-spawn-plan.ts`: Set `args = [...opts.terminalShellArgs]` when provided without `opts.command` on Windows.
  - `src/main/providers/orcad-native-pty-provider.integration.test.ts`: Remove artificial `provider.write(spawnRes.id, 'exit\r\n')` line.
- **Build status**: All unit, integration, and typecheck suites passing with 0 errors.
- **Pending issues**: None.

## Quality Status

- **Build/test result**: 12/12 tests passing across 4 suites; `pnpm tc` passed cleanly.
- **Lint status**: 0 errors, 0 warnings with `oxlint`.
- **Tests added/modified**: Updated unit and integration tests for contract adherence and clean process termination.

## Loaded Skills

- None requested
