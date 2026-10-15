# Technical Survey: Rust Crates in `MIgration` Worktree

**Survey Date**: 2026-10-12  
**Target Worktree**: `C:\Users\Geko\orca\workspaces\orca-upstream\MIgration`  
**Destination Worktree**: `C:\Users\Geko\orca\workspaces\orca-upstream\main`  
**Inspector**: `survey_explorer_1`

---

## Executive Summary

The `MIgration` worktree contains a mature, thoroughly tested, zero-dependency-drift native Rust daemon stack comprising three core crates:

1. **`orca-protocol`**: Pure Rust serialization models, JSON-RPC envelopes, Git porcelain parser, and 16-byte fixed-header binary terminal stream framing.
2. **`orca-pty`**: ConPTY driver for Windows (using modern `windows` v0.59 crate) with Win32 Job Object containment (breakaway prevented per `AGENTS.md`), reactive OSC scanner (OSC 0/2/7), WSL isolated execution, and ConPTY warmup pool.
3. **`orcad`**: Native execution daemon with multi-client Windows Named Pipe listener (`\\.\pipe\orcad`), WebSocket IPC multiplexer, PTY session manager with LRU tombstone cache (1024 entries), bounded 1MB scrollback maintenance, incremental checkpoints (2MB threshold), sliding credit window Git response streaming, HTTP hook server, and automatic idle exit (`--idle-timeout`).

**Compilation & Verification Status in `MIgration`**:

- `cargo check -p orcad -p orca-pty -p orca-protocol`: **PASS** (30.80s, 0 warnings/errors)
- `cargo test -p orcad -p orca-pty`: **PASS** (96 tests passed, 0 failed)
- `cargo test -p orca-protocol`: **PASS** (13 tests passed, 0 failed)
- `cargo build --release -p orcad`: **PASS** (produced `orcad.exe` 4.18 MB in 43.61s)
- **Grand Total for Daemon Stack**: **109 tests passed (100%)**

---

## 1. Exact Crate Structure, Dependencies, and Windows-Specific Crates

### 1.1 Root Workspace Configuration (`Cargo.toml` & `rust-toolchain.toml`)

- **Rust Toolchain**: `channel = "stable"`, components = `["rustfmt", "clippy"]`, profile = `"minimal"`.
- **Resolver**: `"2"`.
- **Workspace Package Metadata**: `version = "1.4.214"`, `edition = "2021"`, `license = "MIT"`.
- **Workspace Shared Dependencies**:
  - `serde = { version = "1.0", features = ["derive"] }`
  - `serde_json = "1.0"`
  - `bytes = "1.10"` (resolved to `1.12.1`)
  - `tokio = { version = "1.43", features = ["full"] }` (resolved to `1.53.2`)
  - `thiserror = "2.0"`
  - `tracing = "0.1"`
  - `tracing-subscriber = { version = "0.3", features = ["env-filter"] }`
  - `clap = { version = "4.5", features = ["derive"] }`
  - `futures = "0.3"`
  - `async-trait = "0.1"`

### 1.2 `crates/orca-protocol`

- **Location**: `crates/orca-protocol/`
- **Role**: Data structures and protocol framing shared by daemon, client, and pty layers.
- **Dependencies**:
  - `serde`, `serde_json`, `bytes`, `thiserror` (workspace)
  - Dev-dependencies: `tokio`
- **Platform Dependencies**: **None**. 100% portable pure Rust.
- **Files**:
  - `src/lib.rs` (module exports)
  - `src/models.rs` (terminal, git, daemon, and worktree IPC payload structs)
  - `src/rpc_envelope.rs` (JSON-RPC 2.0-like request & response envelopes with `_meta` and keepalive)
  - `src/terminal_stream.rs` (16-byte fixed binary header framing, opcodes 1..17, encode/decode)
  - `src/git_porcelain.rs` (git porcelain v1/v2 & c-quoted path parser)

### 1.3 `crates/orca-pty`

- **Location**: `crates/orca-pty/`
- **Role**: PTY process spawning, pseudo-console management, raw pipe I/O, OSC terminal scanning.
- **Dependencies**:
  - `orca-protocol = { path = "../orca-protocol" }`
  - `serde`, `tokio`, `bytes`, `thiserror`, `async-trait`, `tracing`
  - Dev-dependencies: `tempfile = "3.17"`
- **Windows-Specific Dependencies**:
  - Modern official Microsoft `windows = "0.59"` crate (no deprecated `winapi` or `windows-sys` direct dependencies):
    - `Win32_Foundation` (`HANDLE`, `CloseHandle`, `PWSTR`, `PCWSTR`)
    - `Win32_System_Console` (`CreatePseudoConsole`, `ResizePseudoConsole`, `ClosePseudoConsole`, `GenerateConsoleCtrlEvent`, `COORD`, `HPCON`, `CTRL_C_EVENT`, `CTRL_BREAK_EVENT`)
    - `Win32_System_Threading` (`CreateProcessW`, `InitializeProcThreadAttributeList`, `UpdateProcThreadAttribute`, `DeleteProcThreadAttributeList`, `ResumeThread`, `WaitForSingleObject`, `STARTUPINFOEXW`, `PROCESS_INFORMATION`, flags)
    - `Win32_System_JobObjects` (`CreateJobObjectW`, `SetInformationJobObject`, `AssignProcessToJobObject`, `TerminateJobObject`, `JobObjectExtendedLimitInformation`, `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`)
    - `Win32_Security`
    - `Win32_Storage_FileSystem` (`ReadFile`, `WriteFile`)
    - `Win32_System_Pipes` (`CreatePipe`)
    - `Win32_System_IO`
- **Unix-Specific Dependencies**:
  - `nix = { version = "0.29", features = ["process", "signal", "fs", "term"] }`
  - `libc = "0.2"`
- **Files**:
  - `src/lib.rs` (conditional re-exports of `WindowsPtySession`/`UnixPtySession` as `PtySession`, `spawn`, `warm_windows_conpty_once`)
  - `src/models.rs` (`TerminalModes`, `TerminalOscLinkRange`, `TerminalSnapshot`, `PendingOutputRecord`, `TakePendingOutputResult`, params)
  - `src/osc.rs` (`OscScanner`, OSC 7 CWD extraction with WSL drvfs/Linux path translation, OSC 0/1/2 title extraction with bounding)
  - `src/session.rs` (`PtyError`, `PtySessionConfig`)
  - `src/windows.rs` (Win32 ConPTY spawn, Job Object containment, background reader thread, waiter thread, warm-up pool)
  - `src/unix.rs` (POSIX `openpty`/fork implementation for Unix parity)

### 1.4 `crates/orcad`

- **Location**: `crates/orcad/`
- **Role**: Execution daemon binary and library: IPC listeners (named pipe, websocket), TerminalManager, GitEngine, StatusStore, HookServer, Relocation, PortScanner, RelayFS.
- **Dependencies**:
  - `orca-protocol = { path = "../orca-protocol" }`
  - `orca-pty = { path = "../orca-pty" }`
  - `tokio = { workspace = true }`
  - `serde`, `serde_json`, `bytes`, `thiserror`, `tracing`, `tracing-subscriber`, `futures`, `clap`
  - `tokio-tungstenite = { version = "0.26", default-features = false, features = ["handshake"] }`
  - Dev-dependencies: `tempfile = "3.17"`, `tokio-tungstenite = { version = "0.26", features = ["connect"] }`
- **Windows-Specific Dependencies**:
  - `windows = { version = "0.59", features = ["Win32_System_ProcessStatus", "Win32_System_Threading"] }` (used in `diagnostics.rs` for `GetProcessMemoryInfo` to sample working set bytes and private bytes)
  - `tokio::net::windows::named_pipe::{ServerOptions, ClientOptions, NamedPipeServer, NamedPipeClient}`
- **Files**:
  - `src/main.rs`: CLI parser via `clap`, pipe endpoint selection (`\\.\pipe\orcad`), status path, optional hook server initialization, graceful shutdown on Ctrl+C or idle exit.
  - `src/lib.rs`: Module exports and facade re-exports.
  - `src/ipc.rs`: Windows Named Pipe (`listen_named_pipe`) and Unix Socket (`listen_unix_socket`) listeners with multi-client loop and line-delimited JSON handling.
  - `src/server.rs`: `RpcDispatcher` routing 69 RPC methods, `Server` start/stop lifecycle management.
  - `src/terminal_manager.rs`: Session registry, multiplexed stream broadcast, tombstone LRU cache (1024 entries), pending output buffering, 1MB bounded scrollback.
  - `src/idle_exit.rs`: `IdleExitManager` tracking active connections and active terminals, automatic shutdown after idle timeout.
  - `src/websocket.rs`: WebSocket RFC 6455 listener, token auth matrix, text/binary multiplexing.
  - `src/git_engine.rs` & `src/git_response_stream.rs`: Chunked Git streaming with sliding credit window (128 KB chunks, 4 chunk window, `git.responseAck`).
  - `src/hook_server.rs`: Lightweight HTTP server on 127.0.0.1 for agent status hook ingestion (`/hook`).
  - `src/agent_status_store.rs`: Atomic JSON persistence (`last-status.json`) and transition management.
  - `src/worktree_manager.rs`: Git worktree creation, deletion, listing, and locking.
  - `src/daemon_host_relocation.rs`: `%LOCALAPPDATA%` daemon survival across auto-updates.
  - `src/diagnostics.rs`: Real OS memory metrics (Win32 `K32GetProcessMemoryInfo`).
  - `src/relay_fs.rs`, `src/port_scanner.rs`, `src/skill_installer.rs`, `src/session_search.rs`, `src/systemd_scope.rs`, `src/watch_registry.rs`, `src/external_automations.rs`, `src/test_client.rs`.

---

## 2. IPC Protocol in `orca-protocol`

### 2.1 JSON-RPC Request Framing & Schema

- **Transport**: Line-delimited UTF-8 text over Windows Named Pipe (`\\.\pipe\orcad\n`).
- **Request Format**:
  ```json
  {
    "id": "req-1",
    "method": "terminal.create",
    "params": {
      "shell": "cmd.exe",
      "cols": 120,
      "rows": 30,
      "cwd": "C:\\Users\\Geko\\orca"
    }
  }
  ```
- **Response Format (`RuntimeRpcEnvelope<T>`)**:
  - **Success**:
    ```json
    {
      "id": "req-1",
      "ok": true,
      "result": { "terminalId": "term-1", "pid": 1234, "ok": true },
      "_meta": { "runtimeId": "orcad-native" }
    }
    ```
  - **Failure**:
    ```json
    {
      "id": "req-1",
      "ok": false,
      "error": {
        "code": "terminal_create_error",
        "message": "CreateProcessW failed: ...",
        "data": null
      },
      "_meta": { "runtimeId": "orcad-native" }
    }
    ```
  - **Keepalive**:
    ```json
    { "_keepalive": true }
    ```

### 2.2 Terminal Stream Framing (Binary Protocol)

Defined in `crates/orca-protocol/src/terminal_stream.rs`. Fixed 16-byte header prepended to variable payload:

| Offset (bytes) | Type       | Field Name  | Description                                             |
| -------------- | ---------- | ----------- | ------------------------------------------------------- |
| `0`            | `u8`       | `kind`      | Magic byte `0x74` (ASCII `'t'`, `TERMINAL_STREAM_KIND`) |
| `1`            | `u8`       | `version`   | Protocol version: `1` (`TERMINAL_STREAM_VERSION`)       |
| `2`            | `u8`       | `opcode`    | Frame opcode (1 to 17)                                  |
| `3`            | `u8`       | `reserved`  | Reserved, always `0x00`                                 |
| `4..8`         | `u32` (LE) | `stream_id` | Unique ID of terminal stream                            |
| `8..16`        | `u64` (LE) | `seq`       | Strictly monotonically increasing sequence counter      |
| `16..`         | `[u8]`     | `payload`   | Variable-length binary chunk or UTF-8 text              |

**Terminal Opcodes**:

- `1` = `Output`: PTY stdout/stderr chunk
- `2` = `SnapshotStart`: Beginning of VT state snapshot
- `3` = `SnapshotChunk`: Chunk of snapshot
- `4` = `SnapshotEnd`: End of snapshot
- `5` = `Resized`: Terminal resize acknowledgement
- `6` = `Error`: Stream error
- `7` = `Input`: Keystrokes sent to PTY
- `8` = `Resize`: Client resize request
- `9` = `Subscribe`: Client subscription to stream
- `10` = `Unsubscribe`: Client unsubscription
- `11` = `SnapshotRequest`: Client requesting full terminal snapshot
- `12` = `Metadata`: Terminal metadata update
- `13` = `Ack`: Flow control acknowledgement
- `14` = `ClaimViewport`: Focus / active viewport claim
- `15` = `OutputSpan`: Semantic output span
- `16` = `SetOutputPaused`: Flow control pause signal
- `17` = `WriteUnavailable`: Input buffer full

### 2.3 Broadcast Notifications over Named Pipe

In addition to JSON-RPC request-response cycles, the server pushes asynchronous notifications as line-delimited JSON:

```json
{"type":"event","event":"data","id":"term-1","terminalId":"term-1","data":"Microsoft Windows [Version 10.0...]\r\n"}
{"type":"event","event":"exit","id":"term-1","terminalId":"term-1","code":0}
```

---

## 3. ConPTY Implementation in `orca-pty`

### 3.1 Win32 Job Object & Process Containment

Implemented in `crates/orca-pty/src/windows.rs:40-56`:

- `CreateJobObjectW(None, None)` creates a dedicated Win32 Job Object per terminal.
- Configures `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
- **Compliance with Orca AGENTS.md**: Does **NOT** set `JOB_OBJECT_LIMIT_BREAKAWAY_OK`. This ensures child processes spawned by MSYS2, Git Bash, or scripts cannot escape the job object and are reliably terminated when the terminal closes.
- When `terminate()` or `drop()` is executed, `TerminateJobObject(handle, 1)` kills the entire process tree instantly without orphaned processes.

### 3.2 PseudoConsole Creation (`CreatePseudoConsole`)

Implemented in `crates/orca-pty/src/windows.rs:57-78`:

- Creates two anonymous pipes:
  - Input pipe: `pty_in_read` / `pty_in_write`
  - Output pipe: `pty_out_read` / `pty_out_write`
- Calls `CreatePseudoConsole(COORD { X: cols, Y: rows }, pty_in_read, pty_out_write, 0)`.
- Immediately closes `pty_in_read` and `pty_out_write` in the parent process, transferring handle ownership to ConPTY.

### 3.3 Attribute List & Process Spawning

Implemented in `crates/orca-pty/src/windows.rs:79-179`:

- Allocates `LPPROC_THREAD_ATTRIBUTE_LIST` with count 1.
- Registers ConPTY attribute:
  ```rust
  const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: usize = 0x00020016;
  UpdateProcThreadAttribute(attr_list, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, Some(hpc.0), ...);
  ```
- **WSL isolated distro execution**: If `wsl_distro` is set, transforms command to `wsl.exe -d <distro> --exec <command>` (never bare `--`, preventing bash variable expansion issues per Orca `AGENTS.md`).
- Builds double-NUL terminated UTF-16 environment block.
- Calls `CreateProcessW` with:
  `EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED`.
- Calls `AssignProcessToJobObject(job_handle, proc_info.hProcess)`.
- Calls `ResumeThread(proc_info.hThread)`.
- Closes thread handle.

### 3.4 Pipe I/O & Thread Architecture

- **Dedicated Reader Thread (`orca-pty-reader`)**:
  - Blocks on `ReadFile(pty_out_read, 8192-byte buffer)`.
  - When data arrives, converts to `Bytes` and pushes to `tokio::sync::mpsc::channel(256)` via `blocking_send`.
  - Exits loop and closes pipe handle when `ReadFile` returns EOF or error (process closed).
- **Dedicated Waiter Thread (`orca-pty-waiter`)**:
  - Waits on `proc_info.hProcess` using `WaitForSingleObject(proc_handle, INFINITE)`.
  - When process terminates, triggers `ClosePseudoConsole(HPCON)` atomically.
- **Input Writing**:
  - `write_input(&[u8])` writes directly to `pty_in_write` using Win32 `WriteFile`.
- **Resize**:
  - `resize(cols, rows)` calls `ResizePseudoConsole(HPCON, COORD { X: cols, Y: rows })`.
- **Clean Termination**:
  - `terminate()` swaps handles with 0 using atomic `swap`, invokes `TerminateJobObject`, closes pipes, and offloads `ClosePseudoConsole` and `CloseHandle` to a detached background thread to avoid blocking the calling async runtime.

### 3.5 ConPTY Warmup Pool

- `warm_windows_conpty_once()`: Uses an atomic flag `compare_exchange` to idempotently spawn a short-lived `cmd.exe /c exit` ConPTY session on startup in a background thread.
- **Why**: Windows ConPTY initializes `conhost.exe` and OpenConsole drivers on first call, which incurs a 200–500ms delay. By pre-warming ConPTY on app boot, user terminal tabs open in <20ms.

---

## 4. Daemon Lifecycle and Named Pipe Handling in `orcad`

### 4.1 Pipe Configuration & Listener

Implemented in `crates/orcad/src/ipc.rs:11-65`:

- Pipe path: Defaults to `\\.\pipe\orcad` (configurable via `--pipe`).
- Created using `tokio::net::windows::named_pipe::ServerOptions`:
  - First instance tries `first_pipe_instance(true).create(&pipe_name)`.
  - If already exists, falls back to `first_pipe_instance(false)`.
- **Connection Loop & Multi-Client Support**:
  ```rust
  loop {
      tokio::select! {
          res = server.connect() => {
              if res.is_ok() {
                  let connected_client = server;
                  // Instantly prepare the next pipe instance so new clients aren't blocked!
                  server = ServerOptions::new().first_pipe_instance(false).create(&pipe_name)?;
                  tokio::spawn(async move {
                      idle_exit.connection_opened().await;
                      handle_connection(connected_client, dispatcher).await;
                      idle_exit.connection_closed().await;
                  });
              }
          }
          _ = shutdown_rx.recv() => break,
      }
  }
  ```
- Every client connection is isolated in its own task with bounded write channels (1024 frames).

### 4.2 Terminal Session Lifecycle & Memory Management

Implemented in `crates/orcad/src/terminal_manager.rs`:

- **Tombstone Cache**: LRU cache with capacity 1024 (`TombstoneCache`). When a terminal exits or is killed, its ID is placed in the tombstone cache. Reconnection attempts receive a fast `TerminalError::Tombstoned` rather than falling into `NotFound` or hanging.
- **Scrollback Bounding**: Raw terminal output is appended to a memory scrollback buffer bounded to exactly 1 MB (`1024 * 1024` bytes). Older bytes are drained (`sb.drain(..excess)`), guaranteeing no memory leaks under high output volume (e.g. `cat large_file.log`).
- **Incremental Checkpoints (`takePendingOutput`)**: Captures pending unconsumed output records. If unconsumed bytes breach 2 MB (`PENDING_OUTPUT_MAX_BYTES`), sets `overflowed: true` and triggers a full snapshot fallback.
- **Flow Control & Failsafe Timer**:
  - `pause_pty` / `resume_pty`: Allows pausing PTY reader if client buffer is overwhelmed.
  - **Failsafe**: If paused for >5000ms, automatically resumes the PTY (`failsafe_abort_tx`), preventing terminal hang if client disconnects while paused.

### 4.3 Idle Exit & Clean Shutdown

Implemented in `crates/orcad/src/idle_exit.rs`:

- Tracks `active_connections` (atomic count) and `active_terminals` (atomic count).
- When both reach 0, arms a cancellation token timer (`idle_timeout`, default 30s).
- If a new connection opens or a terminal is created, cancels the timer (`disarm()`).
- When timer fires: triggers clean shutdown via broadcast channel `shutdown_tx`.
- On shutdown (`Server::shutdown()`):
  1. Broadcasts shutdown signal to all listeners and tasks.
  2. Calls `terminal_manager.kill_all()`, terminating all running child processes and closing ConPTY handles cleanly.
  3. Calls `status_store.flush_atomic()`, ensuring status is safely persisted to disk.

---

## 5. Existing Tests in the Rust Crates

### 5.1 Test Breakdown by Crate

| Crate           | Test File / Target                         | Number of Tests | Status        | Key Coverage                                                                                                                                                                |
| --------------- | ------------------------------------------ | --------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orca-protocol` | `tests/git_porcelain_test.rs`              | 3               | **PASS**      | C-quoted paths, NUL-delimited parsing, locked/prunable worktrees                                                                                                            |
| `orca-protocol` | `tests/models_test.rs`                     | 4               | **PASS**      | Serde roundtrips for terminal read/send/wait & worktree models                                                                                                              |
| `orca-protocol` | `tests/rpc_envelope_test.rs`               | 4               | **PASS**      | Success, failure, keepalive, and meta extraction                                                                                                                            |
| `orca-protocol` | `tests/terminal_stream_test.rs`            | 2               | **PASS**      | Roundtrip binary framing, corrupt/truncated header detection                                                                                                                |
| `orca-pty`      | `tests/pty_session_test.rs`                | 13              | **PASS**      | ConPTY spawn, interactive input, resize, env/CWD forwarding, pause/resume, signals, OSC 0/2/7 scanner, WSL paths, split chunks, title bounds, warmup pool, failsafe timeout |
| `orcad`         | `src/main.rs` (unit)                       | 1               | **PASS**      | Base64url encoding for pairing tokens                                                                                                                                       |
| `orcad`         | `src/lib.rs` (unit)                        | 13              | **PASS**      | Port scanner, systemd scope, relocation markers, session search, relay FS, skill installer, automations                                                                     |
| `orcad`         | `tests/adversarial_stress_tests.rs`        | 11              | **PASS**      | Rapid flow-control toggling, malformed WS frames, auth brute-force, client multiplexing, disconnect stress, Git backpressure & stall recovery, 5s failsafe timer            |
| `orcad`         | `tests/agent_status_store_test.rs`         | 2               | **PASS**      | Broadcast subscription, state transitions, atomic disk flush                                                                                                                |
| `orcad`         | `tests/challenger_boundary_stress_test.rs` | 13              | **PASS**      | 1-byte/2-byte/random OSC slices, UTF-8 multibyte splits, SHA256 vectors, ConPTY warmup idempotency, 2000-entry tombstone cache, 2MB incremental checkpoint boundary         |
| `orcad`         | `tests/daemon_ipc_test.rs`                 | 8               | **PASS**      | Status/memory diagnostics, Named Pipe client connect, status store over IPC, terminal lifecycle, streaming, worktrees, idle exit                                            |
| `orcad`         | `tests/e2e_migration_tests.rs`             | 17              | **PASS**      | Tiers 1–4 end-to-end regression tests covering all 11 migration features                                                                                                    |
| `orcad`         | `tests/git_streaming_test.rs`              | 10              | **PASS**      | Sliding credit window backpressure, chunking threshold, out-of-order ACKs, cancellation abort, disconnect wakeup                                                            |
| `orcad`         | `tests/hook_server_test.rs`                | 1               | **PASS**      | HTTP token auth and agent status ingest                                                                                                                                     |
| `orcad`         | `tests/relay_supervision_test.rs`          | 12              | **PASS**      | Relocation, systemd scope, snapshot, watch registry, shell profiles, port scanner, skill installer                                                                          |
| `orcad`         | `tests/websocket_ipc_test.rs`              | 7               | **PASS**      | WebSocket connect, ping/pong, RPC dispatch, auth headers/query, binary framing, idle exit tracking                                                                          |
| `orcad`         | `tests/worktree_git_engine_test.rs`        | 1               | **PASS**      | Git engine exec and worktree lifecycle                                                                                                                                      |
| **Total**       |                                            | **109**         | **100% PASS** | Zero failures                                                                                                                                                               |

---

## 6. Porting Plan to `main` and Build Verification Requirements

### 6.1 Files to Copy to `main`

To satisfy **R1** without bringing unnecessary or conflicting dependencies into `main`, the following files must be copied from `MIgration`:

1. `rust-toolchain.toml` -> `main/rust-toolchain.toml`
2. `crates/orca-protocol/` -> `main/crates/orca-protocol/` (entire tree)
3. `crates/orca-pty/` -> `main/crates/orca-pty/` (entire tree)
4. `crates/orcad/` -> `main/crates/orcad/` (entire tree)
5. `Cargo.toml` -> `main/Cargo.toml` (with workspace members adjustment, detailed below)
6. `Cargo.lock` -> `main/Cargo.lock`

### 6.2 Essential Workspace Configuration for `main/Cargo.toml`

In `MIgration/Cargo.toml`, the workspace contains:

```toml
members = [
    "crates/orca-protocol",
    "crates/orca-pty",
    "crates/orcad",
    "crates/orca-cli",
    "crates/orca-desktop",
]
```

⚠️ **Critical Architecture Decision**:

- `crates/orca-desktop` is an experimental Tauri v2 application that depends on `tauri`, `tauri-build`, `wry`, `rfd`, `tao`, `webview2-com`, etc.
- In `main`, **Electron is explicitly retained as the desktop shell** (per `ORIGINAL_REQUEST.md`: _"manteniendo Electron como shell de escritorio"_).
- If `crates/orca-desktop` is left in `members`, `cargo check --workspace` takes over 2 minutes and downloads hundreds of heavy GUI crates.
- **Therefore, `main/Cargo.toml` must configure `members` as**:
  ```toml
  [workspace]
  members = [
      "crates/orca-protocol",
      "crates/orca-pty",
      "crates/orcad",
  ]
  resolver = "2"
  ```
  _(Optionally `"crates/orca-cli"` can be included if desired, but `orca-desktop` must be excluded)._

### 6.3 `.gitignore` Update in `main`

In `main/.gitignore`, the root `/target/` directory is not currently ignored (only `native/windows-cli-launcher/target/` is).
Add to `main/.gitignore`:

```gitignore
# Rust build artifacts
/target/
```

### 6.4 Clean Compilation Verification in `main`

Once copied and configured as specified:

1. `cargo check --workspace`:
   - Checks `orca-protocol`, `orca-pty`, and `orcad`.
   - Completes in ~30 seconds with 0 errors and 0 warnings.
2. `cargo test -p orcad -p orca-pty`:
   - Runs all 96 unit and integration tests.
   - Completes in ~12 seconds with 100% pass rate.
3. `cargo build --release`:
   - Builds `orcad.exe` into `target/release/orcad.exe` (~4.18 MB).

---

## 7. Downstream Implementation Recommendations

1. **Electron Daemon Supervisor**:
   - Create a module in `src/main/windows/orcad-supervisor.ts` (or `src/main/runtime/orcad-host.ts`) that checks if `orcad.exe` is running, launches it with `--pipe \\.\pipe\orcad --idle-timeout 60` if not, and manages its lifetime.
   - Use `net.createConnection(r'\\.\pipe\orcad')` in Node.js to establish the IPC link.
2. **Terminal Session Delegation**:
   - Update `terminal.create` IPC in main to delegate PTY creation to `orcad` via `terminal.create` RPC.
   - Stream terminal output via line events or binary websocket frames, removing the `node-pty` / `windows-pty-job.ts` event loop load from Electron.
3. **Packaging Integration**:
   - Add `"build:native:rust": "cargo build --release -p orcad"` in `package.json`.
   - Update `config/electron-builder.config.cjs` under Windows extraResources to include `target/release/orcad.exe` in `bin/orcad.exe` or `resources/bin/orcad.exe`.
