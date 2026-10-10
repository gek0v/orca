# Rust Migration of Orca Execution Backbone (orcad Daemon & CLI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a high-performance, drop-in replacement for Orca's background execution daemon (`orcad`) and CLI in Rust, cutting idle memory from ~150 MB to < 10 MB, eliminating GC pauses during terminal streaming, and providing sub-5ms CLI execution.

**Architecture:** The execution backbone is structured as a modular Cargo workspace (`crates/`). `orca-protocol` implements zero-copy JSON-RPC envelopes and 16-byte binary terminal stream framing. `orca-pty` wraps native ConPTY with strict Win32 Job Objects (preventing MSYS/Git Bash breakaway leaks) and POSIX PTYs. `orcad` runs an async Tokio daemon serving Named Pipes and Unix Sockets while acting as the single source of truth for the Agent Status Store. `orca-cli` uses `clap` to provide instant CLI access.

**Tech Stack:** Rust (stable), Tokio, Serde, Serde JSON, Bytes, Windows-rs (ConPTY & Win32 Job Objects), Nix / portable-pty (POSIX), Tungstenite (WebSockets), Clap v4.

**Spec:** [docs/superpowers/specs/2026-10-11-rust-orcad-daemon-migration-design.md](file:///C:/Users/Geko/orca/workspaces/orca-upstream/MIgration/docs/superpowers/specs/2026-10-11-rust-orcad-daemon-migration-design.md)

## Global Constraints

- Must achieve bit-for-bit wire compatibility with TypeScript `RuntimeRpcEnvelope` (`src/shared/runtime-rpc-envelope.ts`) and 16-byte binary framing (`src/shared/terminal-stream-protocol.ts`).
- Windows ConPTY Job Objects MUST NOT use `JOB_OBJECT_LIMIT_BREAKAWAY_OK`, ensuring child processes cannot escape and lock worktrees.
- Agent Status Store verdicts MUST adhere strictly to `live`, `unverifiable`, and `exited` (loss of contact marks as `unverifiable`, never `exited`).
- Must operate seamlessly with the existing Electron application over Named Pipes (`\\.\pipe\orcad-{profile}-{id}`) and Unix Sockets (`/tmp/orcad-{profile}.sock`).
- All code formatted with `cargo fmt`, passing `cargo clippy --all-targets --all-features -- -D warnings`.

## Review Focus

1. **MSYS/Git Bash child process escape:** An interactive bash session spawns background commands; closing the terminal tab must reap 100% of child processes via `TerminateJobObject`.
2. **Wire framing endianness & alignment:** 16-byte binary terminal frames must preserve little-endian `u32` stream ID and `u64` sequence number exactly matching JavaScript `DataView`.
3. **Additive JSON-RPC properties:** Clients and daemon update independently; unknown incoming JSON-RPC properties must be ignored gracefully without deserialization failure.
4. **SSH / Disconnection verdict truthfulness:** A remote client disconnecting abruptly must transition status to `unverifiable`, never falsely marking the agent as `exited`.
5. **Idle exit cleanup:** When all clients disconnect and no active terminal sessions remain, `orcad` must shut down cleanly after the deadline and unlink socket/pipe handles.

---

### Task 1: Cargo Workspace & Rust Toolchain Setup

**Files:**
- Create: `Cargo.toml`
- Create: `rust-toolchain.toml`
- Create: `crates/orca-protocol/Cargo.toml`
- Create: `crates/orca-protocol/src/lib.rs`
- Create: `crates/orca-pty/Cargo.toml`
- Create: `crates/orca-pty/src/lib.rs`
- Create: `crates/orcad/Cargo.toml`
- Create: `crates/orcad/src/main.rs`
- Create: `crates/orca-cli/Cargo.toml`
- Create: `crates/orca-cli/src/main.rs`

**Interfaces:**
- Produces: Compilable Cargo workspace with 4 initialized crates.

- [ ] **Step 1: Install Rust stable toolchain if unconfigured**

Run: `rustup default stable`
Expected: Successfully configured default stable toolchain.

- [ ] **Step 2: Create root `Cargo.toml` and `rust-toolchain.toml`**

Define root workspace members:
```toml
[workspace]
members = [
    "crates/orca-protocol",
    "crates/orca-pty",
    "crates/orcad",
    "crates/orca-cli",
]
resolver = "2"

[workspace.package]
version = "1.4.214"
edition = "2021"
authors = ["Orca Team"]
license = "MIT"
```

- [ ] **Step 3: Scaffold crate manifests and initial entrypoints**

Configure dependencies in:
- `crates/orca-protocol/Cargo.toml`: `serde`, `serde_json`, `bytes`, `thiserror`.
- `crates/orca-pty/Cargo.toml`: `orca-protocol`, `tokio`, `thiserror`, target-specific `windows` / `nix`.
- `crates/orcad/Cargo.toml`: `orca-protocol`, `orca-pty`, `tokio` (full), `tokio-tungstenite`, `tracing`, `tracing-subscriber`.
- `crates/orca-cli/Cargo.toml`: `orca-protocol`, `clap` (derive), `tokio` (macros, rt-multi-thread).

- [ ] **Step 4: Verify workspace builds**

Run: `cargo check --workspace`
Expected: PASS with 0 errors.

- [ ] **Step 5: Commit scaffolding**

```bash
git add -f Cargo.toml rust-toolchain.toml crates/
git commit -m "chore(rust): scaffold Cargo workspace for orcad and orca-cli"
```

---

### Task 2: `orca-protocol`: JSON-RPC Envelopes & Binary Terminal Streaming

**Files:**
- Create: `crates/orca-protocol/src/rpc_envelope.rs`
- Create: `crates/orca-protocol/src/terminal_stream.rs`
- Create: `crates/orca-protocol/src/lib.rs`
- Test: `crates/orca-protocol/tests/rpc_envelope_test.rs`
- Test: `crates/orca-protocol/tests/terminal_stream_test.rs`

**Interfaces:**
- Consumes: Raw bytes / JSON strings.
- Produces: `RuntimeRpcEnvelope<T>`, `TerminalStreamFrame`, `TerminalStreamOpcode`, `encode_terminal_stream_frame`, `decode_terminal_stream_frame`.

- [ ] **Step 1: Write failing tests for JSON-RPC Envelope and Terminal Stream framing**

In `crates/orca-protocol/tests/terminal_stream_test.rs`:
```rust
use orca_protocol::terminal_stream::{
    decode_terminal_stream_frame, encode_terminal_stream_frame, TerminalStreamFrame, TerminalStreamOpcode,
};

#[test]
fn test_roundtrip_terminal_stream_frame() {
    let frame = TerminalStreamFrame {
        opcode: TerminalStreamOpcode::Output,
        stream_id: 42,
        seq: 100500,
        payload: bytes::Bytes::from_static(b"\x1b[32mhello world\x1b[0m"),
    };
    let encoded = encode_terminal_stream_frame(&frame);
    assert_eq!(encoded[0], 0x74); // 't'
    assert_eq!(encoded[1], 1);    // version
    assert_eq!(encoded[2], 1);    // Output opcode
    let decoded = decode_terminal_stream_frame(&encoded).expect("frame must decode");
    assert_eq!(decoded.stream_id, 42);
    assert_eq!(decoded.seq, 100500);
    assert_eq!(decoded.payload.as_ref(), b"\x1b[32mhello world\x1b[0m");
}
```

In `crates/orca-protocol/tests/rpc_envelope_test.rs`:
```rust
use orca_protocol::rpc_envelope::{RuntimeRpcEnvelope, RpcSuccess};

#[test]
fn test_roundtrip_rpc_success_with_additive_fields() {
    let json = r#"{"id":"req-1","ok":true,"result":{"status":"ok"},"_meta":{"runtimeId":"rt-123","futureExtraField":true}}"#;
    let envelope: RuntimeRpcEnvelope<serde_json::Value> = serde_json::from_str(json).unwrap();
    match envelope {
        RuntimeRpcEnvelope::Success(s) => {
            assert_eq!(s.id, "req-1");
            assert_eq!(s._meta.runtime_id, "rt-123");
        }
        _ => panic!("Expected Success envelope"),
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p orca-protocol`
Expected: FAIL (modules not implemented).

- [ ] **Step 3: Implement `rpc_envelope.rs` and `terminal_stream.rs`**

- Implement `RuntimeRpcEnvelope` with serde untagged representation and camelCase serialization.
- Implement 16-byte fixed header encoder/decoder using `bytes::BytesMut` and `bytes::BufMut`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p orca-protocol`
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add -f crates/orca-protocol/
git commit -m "feat(orca-protocol): implement JSON-RPC envelope and terminal stream framing"
```

---

### Task 3: `orca-pty`: Cross-Platform PTY & Win32 Job Object Isolation

**Files:**
- Create: `crates/orca-pty/src/windows.rs` (conditional `#[cfg(windows)]`)
- Create: `crates/orca-pty/src/unix.rs` (conditional `#[cfg(unix)]`)
- Create: `crates/orca-pty/src/session.rs`
- Create: `crates/orca-pty/src/lib.rs`
- Test: `crates/orca-pty/tests/pty_session_test.rs`

**Interfaces:**
- Consumes: Shell command, arguments, environment map, initial cols/rows.
- Produces: `PtySession` trait with `write_input(&[u8])`, `resize(cols, rows)`, `read_output() -> Stream<Item = Bytes>`, `terminate()`.

- [ ] **Step 1: Write failing test for PTY lifecycle**

In `crates/orca-pty/tests/pty_session_test.rs`:
```rust
use orca_pty::PtySessionConfig;
use tokio::time::{sleep, Duration};

#[tokio::test]
async fn test_pty_spawn_and_read() {
    let config = if cfg!(windows) {
        PtySessionConfig::new("cmd.exe", vec!["/c".into(), "echo ORCA_PTY_OK".into()], 80, 24)
    } else {
        PtySessionConfig::new("sh", vec!["-c".into(), "echo ORCA_PTY_OK".into()], 80, 24)
    };
    let mut session = orca_pty::spawn(config).await.expect("PTY must spawn");
    let mut output = String::new();
    while let Some(chunk) = session.next_output().await {
        output.push_str(&String::from_utf8_lossy(&chunk));
        if output.contains("ORCA_PTY_OK") {
            break;
        }
    }
    assert!(output.contains("ORCA_PTY_OK"));
    session.terminate().await.expect("PTY must terminate cleanly");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p orca-pty`
Expected: FAIL.

- [ ] **Step 3: Implement Win32 ConPTY and POSIX PTY drivers**

- On Windows: Use `CreatePseudoConsole`, `CreateJobObjectW`, `SetInformationJobObject` with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` without `JOB_OBJECT_LIMIT_BREAKAWAY_OK`.
- On Unix: Use `openpty` + `AsyncFd` + `setpgid`.
- Wire asynchronous I/O channels in `session.rs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p orca-pty`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -f crates/orca-pty/
git commit -m "feat(orca-pty): implement ConPTY with Job Objects and POSIX PTY"
```

---

### Task 4: `orcad`: Tokio Async Daemon, IPC Transports & Lifecycle

**Files:**
- Create: `crates/orcad/src/server.rs`
- Create: `crates/orcad/src/ipc.rs`
- Create: `crates/orcad/src/terminal_manager.rs`
- Create: `crates/orcad/src/idle_exit.rs`
- Create: `crates/orcad/src/main.rs`
- Test: `crates/orcad/tests/daemon_ipc_test.rs`

**Interfaces:**
- Consumes: `orca-protocol`, `orca-pty`.
- Produces: `orcad` daemon binary with IPC server, terminal multiplexing, and managed idle exit.

- [ ] **Step 1: Write failing test for daemon IPC connectivity and terminal creation**

In `crates/orcad/tests/daemon_ipc_test.rs`:
```rust
#[tokio::test]
async fn test_daemon_client_connect_and_ping() {
    let test_pipe_or_sock = if cfg!(windows) {
        format!(r"\\.\pipe\orcad-test-{}", std::process::id())
    } else {
        format!("/tmp/orcad-test-{}.sock", std::process::id())
    };
    let daemon = orcad::Server::start(&test_pipe_or_sock).await.expect("Daemon must start");
    let mut client = orcad::test_client::connect(&test_pipe_or_sock).await.expect("Client must connect");
    let resp = client.send_ping().await.expect("Ping must succeed");
    assert!(resp._keepalive);
    daemon.shutdown().await.expect("Daemon must stop");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p orcad`
Expected: FAIL.

- [ ] **Step 3: Implement Tokio Named Pipe & Unix Socket servers with idle shutdown**

- Implement IPC listener in `ipc.rs`.
- Implement RPC dispatcher in `server.rs` matching `terminal.create`, `terminal.input`, `terminal.resize`, `terminal.kill`.
- Implement `idle_exit.rs` with atomic reference counter and cancellation deadline.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p orcad`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -f crates/orcad/
git commit -m "feat(orcad): implement async IPC daemon with terminal manager and idle exit"
```

---

### Task 5: `orcad`: Agent Status Store & Atomic State Persistence

**Files:**
- Create: `crates/orcad/src/agent_status_store.rs`
- Modify: `crates/orcad/src/server.rs`
- Test: `crates/orcad/tests/agent_status_store_test.rs`

**Interfaces:**
- Consumes: Agent session notifications, hook events.
- Produces: `AgentStatusStore`, `AgentVerdict` (`Live`, `Unverifiable`, `Exited`), atomic write to `last-status.json`.

- [ ] **Step 1: Write failing test for Agent Status Store transitions and persistence**

In `crates/orcad/tests/agent_status_store_test.rs`:
```rust
use orcad::agent_status_store::{AgentStatusStore, AgentVerdict};

#[tokio::test]
async fn test_agent_status_transitions_and_flush() {
    let temp_dir = tempfile::tempdir().unwrap();
    let status_path = temp_dir.path().join("last-status.json");
    let store = AgentStatusStore::new(&status_path);
    store.update_status("session-1", AgentVerdict::Live, "Planning task").await;
    assert_eq!(store.get_status("session-1").await.unwrap().verdict, AgentVerdict::Live);
    store.mark_unverifiable("session-1").await;
    assert_eq!(store.get_status("session-1").await.unwrap().verdict, AgentVerdict::Unverifiable);
    store.flush_atomic().await.expect("Atomic flush must succeed");
    assert!(status_path.exists());
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p orcad --test agent_status_store_test`
Expected: FAIL.

- [ ] **Step 3: Implement `AgentStatusStore` with atomic file persistence**

- Implement thread-safe store with `Arc<RwLock<HashMap<String, AgentRow>>>`.
- Implement atomic file replacement via temp file + rename.
- Expose subscription broadcast channel for `worktree.ps` readers.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p orcad --test agent_status_store_test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -f crates/orcad/
git commit -m "feat(orcad): implement canonical agent status store and atomic snapshot persistence"
```

---

### Task 6: `orca-cli`: Native Command-Line Interface

**Files:**
- Create: `crates/orca-cli/src/commands.rs`
- Create: `crates/orca-cli/src/client.rs`
- Create: `crates/orca-cli/src/format.rs`
- Create: `crates/orca-cli/src/main.rs`
- Test: `crates/orca-cli/tests/cli_e2e_test.rs`

**Interfaces:**
- Consumes: `orcad` IPC socket.
- Produces: Native `orca` binary supporting `orca ps`, `orca terminal`, `--json`.

- [ ] **Step 1: Write failing test for CLI commands**

In `crates/orca-cli/tests/cli_e2e_test.rs`:
```rust
use assert_cmd::Command;

#[test]
fn test_cli_help() {
    let mut cmd = Command::cargo_bin("orca").unwrap();
    cmd.arg("--help");
    cmd.assert().success().stdout(predicates::str::contains("IDE for parallel agentic development"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p orca-cli`
Expected: FAIL.

- [ ] **Step 3: Implement CLI commands using `clap` and IPC client**

- Define CLI arguments with `clap(derive)` matching `src/cli/index.ts`.
- Connect to `orcad` daemon, execute RPC, format human-readable table or raw JSON.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p orca-cli`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -f crates/orca-cli/
git commit -m "feat(orca-cli): implement native command-line interface with sub-5ms cold start"
```

---

### Task 7: Smoke Test Execution & Electron Integration Verification

**Files:**
- Modify: `config/scripts/runtime-serve-terminal-smoke.mjs`
- Test: `pnpm run smoke:orcad-terminal`

**Interfaces:**
- Consumes: Built `./target/release/orcad` binary.
- Produces: Successful end-to-end smoke verification against Orca's existing test gate.

- [ ] **Step 1: Build release binaries for `orcad` and `orca-cli`**

Run: `cargo build --release -p orcad -p orca-cli`
Expected: Successful release compilation creating `target/release/orcad.exe` (or `target/release/orcad`).

- [ ] **Step 2: Run existing smoke test pointing to the Rust binary**

Run: `node config/scripts/runtime-serve-terminal-smoke.mjs --target orcad --daemon-bin ./target/release/orcad`
Expected: PASS (terminals spawned, data echoed, session exited cleanly).

- [ ] **Step 3: Measure performance improvements**

Run: `pnpm run bench:daemon-coldstart`
Run: `pnpm run bench:idle-cpu`
Expected: Memory usage < 10 MB RSS (vs 150 MB baseline), cold start < 15 ms.

- [ ] **Step 4: Commit integration script update**

```bash
git add config/scripts/runtime-serve-terminal-smoke.mjs
git commit -m "test(orcad): verify Rust daemon against runtime serve terminal smoke gate"
```
