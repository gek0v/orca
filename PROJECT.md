# Project: Native Orcad Daemon Migration to Main

## Architecture

- **Rust Native Subsystem (`crates/`)**:
  - `crates/orca-protocol`: Shared serialization, 16-byte fixed binary header (`HEADER_BYTES = 16`, magic `0x74`, version `1`), RPC envelope structures, and error codes.
  - `crates/orca-pty`: ConPTY driver on Windows (`windows` v0.59), Job Object containment (breakaway prevented per `AGENTS.md`), ConPTY warmup pool, dedicated `orca-pty-reader` thread feeding Tokio channels, OSC 0/2/7 parser.
  - `crates/orcad`: Daemon lifecycle, Windows Named Pipe listener (`\\.\pipe\orcad` or `\\.\pipe\orcad-desktop-${pid}`), 1024-entry tombstone cache, bounded 1MB scrollback buffer with excess draining, 5s pause failsafe timer, idle exit manager (`--idle-timeout`), multi-client broadcast.
- **Electron Main Process (`src/main/`)**:
  - `src/main/providers/orcad-native-pty-client.ts`: Named Pipe IPC client using Node `net.Socket` and `readline` for line-delimited JSON-RPC, spawning `orcad.exe` via `src/shared/child-process/spawn-process` (`spawnProcess`).
  - `src/main/providers/orcad-native-pty-provider.ts`: Implements `IPtyProvider`, delegating terminal lifecycle and data streaming to `OrcadNativePtyClient`.
  - `src/main/daemon/daemon-provider-init.ts`: Discovers `orcad.exe` and installs `OrcadNativePtyProvider` with automatic fallback to legacy daemon spawner if unavailable.
- **Distribution & Packaging (`config/`)**:
  - `config/scripts/packaged-native-binaries.cjs`: Maps `target/release/orcad.exe` (or `dist/bin/orcad.exe`) to `bin/orcad.exe` in `extraResources`.
  - `config/electron-builder.config.cjs`: Bundles `orcad.exe` into Windows distribution package under `resources/bin/orcad.exe`.

## Feature Inventory

| #   | Feature                                | Description                                                                                                                                                                | Milestone | Source                       |
| --- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------------------------- |
| 1   | Rust Crates Port                       | Port `crates/orcad`, `crates/orca-pty`, `crates/orca-protocol`, `Cargo.lock`, `rust-toolchain.toml`, and configure `Cargo.toml` workspace members and `.gitignore`         | M1        | Survey 1, R1                 |
| 2   | Rust Compilation & Test Suite          | Clean compilation with `cargo check --workspace` and passing all 109 tests via `cargo test -p orcad -p orca-pty -p orca-protocol` on Windows; release build of `orcad.exe` | M1        | Survey 1, R1                 |
| 3   | Electron Named Pipe Client             | Implement `OrcadNativePtyClient` communicating with `orcad` via Windows Named Pipe using `spawnProcess` (per `AGENTS.md`) and line-delimited JSON-RPC                      | M2        | Survey 2, R2                 |
| 4   | Electron PTY Provider Adapter          | Implement `OrcadNativePtyProvider` conforming to `IPtyProvider` with `pauseProducer`/`resumeProducer`, proxying data to Chromium renderers                                 | M2        | Survey 2, R2                 |
| 5   | Daemon Provider Discovery & Adoption   | Update `daemon-provider-init.ts` and `orcad-local-serve-selection.ts` to detect `orcad.exe` and adopt `OrcadNativePtyProvider` by default with graceful fallback           | M2        | Survey 2, R2                 |
| 6   | Windows Packaging Configuration        | Add `packaged-native-binaries.cjs` and update `config/electron-builder.config.cjs` to include `orcad.exe` in Windows distribution `extraResources`                         | M2        | Survey 3, R4                 |
| 7   | Build Scripts for Native Daemon        | Update `package.json` with `build:native:rust` (`cargo build --release -p orcad`) and integrate into `build:win`                                                           | M2        | Survey 3, R4                 |
| 8   | UI Reactivity & Zero-Freeze Validation | Verify terminal streaming does not block V8 main loop, eliminate "Orca no responde" freezes under high load, run benchmarks and integration tests                          | M3        | Survey 2, R3                 |
| 9   | Goal & TypeScript Verification         | Validate `pnpm tc` passing cleanly and execute `node out/cli/index.js goal complete <id>` and `node out/cli/index.js goal validate` for all 5 subtasks                     | M3        | Survey 3, Goal-1791824736032 |

## Milestones

| #   | Name                                         | Scope                                                                                                                                                                                                                                                                                           | Dependencies | Status |
| --- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------ |
| M1  | Rust Native Subsystem Integration            | Port crates (`orcad`, `orca-pty`, `orca-protocol`), configure `Cargo.toml`/`Cargo.lock`/`.gitignore`, compile cleanly with `cargo check`, pass 109 tests with `cargo test`, build release `orcad.exe`; complete Subtasks 1 & 2 in goal                                                          | None         | DONE   |
| M2  | Electron IPC & Packaging Integration         | Implement `OrcadNativePtyClient` (with `spawnProcess`), `OrcadNativePtyProvider` (with `pauseProducer`), provider adoption in `daemon-provider-init.ts`, packaging in `packaged-native-binaries.cjs` and `electron-builder.config.cjs`, `package.json` scripts; complete Subtasks 3 & 4 in goal | M1           | DONE   |
| M3  | E2E Validation, Goal Validation & Reactivity | Validate zero-freeze UI reactivity, run Playwright E2E / integration tests, verify `pnpm tc`, complete Subtask 5, and run `node out/cli/index.js goal validate`                                                                                                                                 | M2           | DONE   |

## Interface Contracts

### `OrcadNativePtyClient` ↔ `orcad.exe` (Windows Named Pipe)

- Pipe path: `\\.\pipe\orcad-desktop-${process.pid}` (per-process instance) or `\\.\pipe\orcad`
- Framing: Line-delimited UTF-8 JSON (`\n`) for RPC; binary framing for high-throughput stream
- RPC Methods:
  - `pty.spawn`: `{ id, shell, args, cwd, env, cols, rows }` -> `{ ok: true, pid }`
  - `pty.write`: `{ id, data }` -> `{ ok: true }`
  - `pty.resize`: `{ id, cols, rows }` -> `{ ok: true }`
  - `pty.kill`: `{ id }` -> `{ ok: true }`
  - `pty.pause`: `{ id }` -> `{ ok: true }`
  - `pty.resume`: `{ id }` -> `{ ok: true }`
- Events from daemon:
  - `{"event": "data", "id": string, "data": string}`
  - `{"event": "exit", "id": string, "exitCode": number}`

### `OrcadNativePtyProvider` ↔ Electron IPC (`IPtyProvider`)

- Implements `IPtyProvider` (`src/main/providers/pty-provider-contract.ts`):
  - `spawn(req: SpawnRequest): Promise<SpawnResponse>`
  - `write(id: string, data: string): Promise<void>`
  - `resize(id: string, cols: number, rows: number): Promise<void>`
  - `shutdown(id: string): Promise<void>`
  - `onData(listener: (event: PtyDataEvent) => void): Disposable`
  - `onExit(listener: (event: PtyExitEvent) => void): Disposable`
  - `pauseProducer(id: string): void`
  - `resumeProducer(id: string): void`

## Code Layout

- `crates/orca-protocol/`: Shared Rust protocol definitions and RPC structures
- `crates/orca-pty/`: Windows ConPTY driver and Job Object execution
- `crates/orcad/`: Native Rust terminal daemon and Named Pipe listener
- `Cargo.toml`: Root Cargo workspace configuration
- `Cargo.lock`: Pinned Cargo dependencies
- `rust-toolchain.toml`: Pinned Rust toolchain configuration
- `src/main/providers/orcad-native-pty-client.ts`: Named Pipe client for orcad
- `src/main/providers/orcad-native-pty-provider.ts`: `IPtyProvider` implementation
- `src/main/providers/orcad-pty-spawn-plan.ts`: Launch parameter translation
- `src/main/daemon/daemon-provider-init.ts`: Provider adoption logic
- `config/scripts/packaged-native-binaries.cjs`: Packaged binary locator
- `config/electron-builder.config.cjs`: Windows distribution packaging configuration
- `package.json`: Build script definitions
