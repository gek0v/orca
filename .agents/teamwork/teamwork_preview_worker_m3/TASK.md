# Task Assignment: Worker M3 E2E Validation, UI Reactivity & Goal Certification

## Mission

Execute Milestone 3:

1. Verify terminal streaming reactivity and zero-freeze UI behavior under Windows:
   - Verify non-blocking Named Pipe IPC streaming and flow control (`pauseProducer`/`resumeProducer`).
   - Run integration tests (`src/main/providers/orcad-native-pty-provider.integration.test.ts`, `src/main/providers/orcad-native-pty-provider.test.ts`, `src/main/daemon/daemon-provider-init.test.ts`, `config/scripts/electron-builder-native-resources.test.mjs`).
   - Run Rust tests (`cargo test -p orcad -p orca-pty -p orca-protocol`).
2. Verify TypeScript typechecking across all workspace projects (`pnpm tc`).
3. Complete goal subtask 5: `node out/cli/index.js goal complete 5`.
4. Certify and validate active goal: `node out/cli/index.js goal validate`.
5. Verify `node out/cli/index.js goal status` confirms 100% completion across all 5 subtasks.
6. Write handoff.md with full logs and verification evidence.
