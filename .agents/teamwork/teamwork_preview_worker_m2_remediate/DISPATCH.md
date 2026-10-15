## 2026-10-12T18:35:37Z

You are worker_m2_remediate, implementing remediation fixes for Milestone 2 in Orca.

Working Directory: C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\teamwork_preview_worker_m2_remediate
Workspace Root: C:\Users\Geko\orca\workspaces\orca-upstream\main
Mandatory reading files:

- C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\ORIGINAL_REQUEST.md
- C:\Users\Geko\orca\workspaces\orca-upstream\main\PROJECT.md
- C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\teamwork_preview_worker_m2_remediate\TASK.md
- Explorer 1 Report: C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\teamwork_preview_explorer_m2_fix_1\handoff.md
- Explorer 2 Report: C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\teamwork_preview_explorer_m2_fix_2\handoff.md
- Explorer 3 Report: C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\teamwork_preview_explorer_m2_fix_3\handoff.md
- Auditor Evidence Report: C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\teamwork_preview_auditor_m2_1\handoff.md

DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your Tasks:

1. Apply the contract fix to `src/main/providers/orcad-native-pty-provider.ts`:
   - Import `writeRefused` from `../../shared/pty-write-settlement`.
   - In `writeWithSettlement`, return `this.client.callRpc('pty.write', ...).then(() => WRITE_ACCEPTED).catch(() => writeRefused('transport_rejected_before_handoff'))`. Remove illegal `error: err` object property.
2. Apply the contract verification in `src/main/providers/orcad-native-pty-provider.test.ts`:
   - Import `WRITE_ACCEPTED` and `writeRefused`.
   - Assert exact equality: `expect(settlement).toEqual(writeRefused('transport_rejected_before_handoff'))` and verify `expect(acceptedSettlement).toEqual(WRITE_ACCEPTED)`.
3. Apply the spawn plan fix to `src/main/providers/orcad-pty-spawn-plan.ts`:
   - On Windows, if `opts.terminalShellArgs && opts.terminalShellArgs.length > 0 && !opts.command`, set `args = [...opts.terminalShellArgs]` directly instead of appending to `resolved.shellArgs`.
4. Fix `src/main/providers/orcad-native-pty-provider.integration.test.ts`:
   - Remove workaround line `provider.write(spawnRes.id, 'exit\r\n')`. Verify the process runs the command and exits cleanly and automatically.
5. Run the test and verification suite:
   - `pnpm test src/main/providers/orcad-native-pty-provider.test.ts`
   - `pnpm test src/main/providers/orcad-native-pty-provider.integration.test.ts`
   - `pnpm test src/main/daemon/daemon-provider-init.test.ts`
   - `pnpm test config/scripts/electron-builder-native-resources.test.mjs`
   - `pnpm tc` (must pass with 0 errors across all targets)
   - `node out/cli/index.js goal validate` (must pass with exit code 0)
   - `npx oxlint src/main/providers/orcad-native-pty-provider.ts src/main/providers/orcad-pty-spawn-plan.ts`
6. Write your changes and handoff report in `handoff.md` and `progress.md` in your working directory.
7. Send a message to orchestrator with your results.
