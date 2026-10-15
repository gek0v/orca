# Task Assignment: Worker M2 Remediation

## Mission

Apply the remediation fixes formulated by the 3 Explorers to resolve all Forensic Audit findings:

1. Fix `src/main/providers/orcad-native-pty-provider.ts`:
   - Use `writeRefused('transport_rejected_before_handoff')` from `../../shared/pty-write-settlement`. Remove illegal `error: err` field.
2. Fix `src/main/providers/orcad-native-pty-provider.test.ts`:
   - Import `WRITE_ACCEPTED` and `writeRefused`. Assert exact contract matching with `toEqual(writeRefused('transport_rejected_before_handoff'))` and `toEqual(WRITE_ACCEPTED)`.
3. Fix `src/main/providers/orcad-pty-spawn-plan.ts`:
   - On Windows, if `opts.terminalShellArgs` is supplied and no `opts.command`, use `[...opts.terminalShellArgs]` directly rather than appending to `['/K', ...]`.
4. Fix `src/main/providers/orcad-native-pty-provider.integration.test.ts`:
   - Remove workaround `exit\r\n` line and verify clean execution and natural process exit.
5. Verification:
   - Run `pnpm test src/main/providers/orcad-native-pty-provider.test.ts`
   - Run `pnpm test src/main/providers/orcad-native-pty-provider.integration.test.ts`
   - Run `pnpm test src/main/daemon/daemon-provider-init.test.ts`
   - Run `pnpm test config/scripts/electron-builder-native-resources.test.mjs`
   - Run `pnpm tc`
   - Run `node out/cli/index.js goal validate`
   - Run `npx oxlint`
6. Produce handoff.md with complete logs.
