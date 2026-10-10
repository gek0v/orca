# Design Spec: Rust Migration of Orca Execution Backbone (orcad Daemon & CLI)

**Date:** 2026-10-11  
**Status:** Approved  
**Author:** Pair Programming Session (Geko & Antigravity)  

---

## 1. Overview & Goals

Orca is an IDE for parallel agentic development comprising over 27,000 TypeScript files across its Electron desktop shell, React renderer, background daemons, and CLI. Running both the desktop client and background services on Node.js / V8 leads to substantial baseline memory footprint (~120–180 MB per idle daemon instance, ~600–1000 MB for the full IDE), GC pauses under heavy terminal output streaming, and slow CLI cold starts (~200–400 ms).

This specification details **Phase 1** of a progressive migration to Rust:
1. **Drop-in Protocol Replacement for `orcad`:** Rewrite the background daemon (`orcad` / relay) in Rust as a drop-in binary that communicates over existing Named Pipes, Unix Domain Sockets, and WebSockets. The existing Electron frontend and runtime clients will interact with it seamlessly with zero changes to frontend code.
2. **Sub-5ms Native CLI (`orca-cli`):** Replace the Node.js CLI with a native Rust binary compiled with `clap`, providing instantaneous execution for shell hooks and commands (`orca ps`, `orca terminal`).
3. **Native OS PTY & Process Isolation (`orca-pty`):** Implement native ConPTY on Windows (with strict Job Object limits to eliminate MSYS/Git Bash process leaks) and POSIX PTY on macOS/Linux.
4. **Foundation for Phase 2 (Tauri Desktop Shell):** Structure the codebase into modular Rust crates so the protocol, PTY, and state logic can be embedded directly into Tauri when migrating the desktop shell away from Electron, preserving the React/Vite renderer without UI rewrites.

### Performance Target Metrics
| Metric | Current (Node.js) | Target (Rust) |
|---|---|---|
| Daemon Idle RSS | ~120 – 180 MB | **< 10 MB** |
| CLI Cold Start | ~250 – 400 ms | **< 5 ms** |
| Terminal Output Throughput | High V8 GC pressure | **Zero-copy, zero GC** |
| Orphan Process Leaks (MSYS/Git Bash) | Mitigated via node-pty patch | **Guaranteed 0 via Job Objects** |

---

## 2. Architecture & Cargo Workspace

A new Cargo workspace is established at the root of the repository under `crates/`:

```
crates/
├── orca-protocol/       # Shared RPC types, serialization, framing & wire contracts
├── orca-pty/            # Cross-platform PTY abstraction (ConPTY / POSIX) & process management
├── orcad/               # Background daemon binary (Tokio runtime, IPC servers, supervisor)
└── orca-cli/            # Command-line interface binary (Clap)
```

```toml
# Cargo.toml (root workspace)
[workspace]
members = [
    "crates/orca-protocol",
    "crates/orca-pty",
    "crates/orcad",
    "crates/orca-cli",
]
resolver = "2"
```

---

## 3. Component Specifications

### 3.1 `crates/orca-protocol`
Provides data models, serialization, and framing compatible bit-for-bit with Orca's TypeScript runtime.

#### JSON-RPC Envelope
Implements the exact contract defined in `src/shared/runtime-rpc-envelope.ts`:
```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RuntimeRpcEnvelope<T> {
    Success(RpcSuccess<T>),
    Failure(RpcFailure),
    Keepalive(RpcKeepalive),
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MetaSuccess {
    pub runtime_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MetaFailure {
    pub runtime_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RpcSuccess<T> {
    pub id: String,
    pub ok: bool, // true
    pub result: T,
    pub _meta: MetaSuccess,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RpcFailure {
    pub id: String,
    pub ok: bool, // false
    pub error: RpcErrorDetail,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub _meta: Option<MetaFailure>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RpcErrorDetail {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RpcKeepalive {
    pub _keepalive: bool, // true
}
```

#### Binary Terminal Streaming Protocol
Implements zero-copy parsing and encoding for the 16-byte binary framing in `src/shared/terminal-stream-protocol.ts`:
- **Header Structure (16 bytes, Little-Endian):**
  - Byte 0: `0x74` (`TERMINAL_STREAM_KIND`, ASCII `'t'`)
  - Byte 1: `0x01` (`TERMINAL_STREAM_VERSION`)
  - Byte 2: `opcode` (`u8`, mapped to `TerminalStreamOpcode`)
  - Byte 3: Reserved (`0x00`)
  - Bytes 4–7: `stream_id` (`u32`)
  - Bytes 8–15: `seq` (`u64`)
  - Bytes 16+: `payload` (ANSI text, snapshot chunks, or JSON metadata)

```rust
use bytes::{Bytes, BytesMut, BufMut};

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalStreamOpcode {
    Output = 1,
    SnapshotStart = 2,
    SnapshotChunk = 3,
    SnapshotEnd = 4,
    Resized = 5,
    Error = 6,
    Input = 7,
    Resize = 8,
    Subscribe = 9,
    Unsubscribe = 10,
    SnapshotRequest = 11,
    Metadata = 12,
    Ack = 13,
    ClaimViewport = 14,
    OutputSpan = 15,
    SetOutputPaused = 16,
    WriteUnavailable = 17,
}
```

---

### 3.2 `crates/orca-pty`
Provides cross-platform pseudo-terminal management and strict process lifetime guarantees.

#### Windows ConPTY & Job Object Enforcement
To honor the invariant documented in `docs/reference/windows-msys-job-breakaway.md`:
1. Every PTY session creates a dedicated Win32 Job Object with `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`.
2. `LimitFlags` **MUST NOT** include `JOB_OBJECT_LIMIT_BREAKAWAY_OK`. When MSYS2/Git Bash sub-processes issue `CREATE_BREAKAWAY_FROM_JOB`, the OS rejects the breakaway with `ERROR_ACCESS_DENIED`, forcing child processes to remain within the job.
3. Sets `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
4. Spawns ConPTY via `CreatePseudoConsole` and `CreateProcessW` attached to the Job Object.
5. `terminate_pty_job()` calls `TerminateJobObject(handle, 1)`, guaranteeing that child processes (e.g. Node, npm, compiler tools) are terminated immediately and never leave locked git worktree directories.

#### POSIX (macOS & Linux)
1. Spawns PTY sessions using `openpty` with non-blocking file descriptors (`O_NONBLOCK`).
2. Registers master PTY file descriptors directly into Tokio's reactor using `tokio::io::unix::AsyncFd`.
3. Creates independent process groups (`setsid` and `setpgid`). Session termination sends `SIGHUP` and `SIGTERM` to the process group (`-pgid`), escalating to `SIGKILL` after a configurable grace deadline (default 2500ms).

#### WSL Execution
When targeting WSL on Windows, spawns `wsl.exe --exec <args>` preserving the contract in `docs/reference/wsl-command-execution.md`.

---

### 3.3 `crates/orcad`
The long-running background daemon replacing `out/main/index.js --target orcad`.

#### IPC Transports
- **Windows:** Named Pipe `\\.\pipe\orcad-{profile}-{id}` using `tokio::net::windows::named_pipe::ServerOptions`.
- **macOS / Linux:** Unix Domain Socket at `/tmp/orcad-{profile}.sock` (or `$XDG_RUNTIME_DIR/orcad.sock`) with strict file mode `0700`.
- **Remote / SSH:** Optional WebSocket server using `tokio-tungstenite` on localhost or forwarded ports.

#### Agent Status Store Authority
In accordance with `docs/reference/agent-status-store.md` and `docs/reference/ssh-execution-boundary.md`:
1. **Host-Owned Truth:** `orcad` owns agent execution status on the host where it runs.
2. **Strict Verdict Vocabulary:** Process states are strictly limited to `live`, `unverifiable`, and `exited` (loss of client contact marks state as `unverifiable`, never `exited`).
3. **Atomic Persistence:** Persists state snapshot to `last-status.json` via atomic write (temp file + atomic filesystem rename) to guarantee survivability across sudden power loss or crashes.
4. **Broadcast Feed:** Pushes state updates to subscribers (Electron sidebar, CLI, web client) using Tokio broadcast channels.

#### Managed Idle Exit (`orcad-managed-idle-exit`)
1. Tracks connected IPC/WebSocket clients and active PTY/agent sessions with atomic counters.
2. When client count reaches zero and no background jobs are active, enters a shutdown countdown (default: 15 minutes).
3. Receiving a new connection or session creation cancels the timer immediately.
4. Clean shutdown flushes status stores, reaps all Job Objects/process groups, and unlinks socket files.

#### Windows Relocation Compatibility
Compatible with deployment under `%LOCALAPPDATA%\Orca\daemon-host\<version>\Orca.exe` to survive electron-builder uninstaller process sweeps during desktop auto-updates without tripping MITRE T1036 Masquerading EDR detections.

---

### 3.4 `crates/orca-cli`
Replaces `out/cli/index.js` as the `orca` binary.

- Implemented using `clap` derive with subcommands:
  - `orca ps`: Connects to `orcad` IPC, reads current worktrees and agent states, outputs tabular or JSON format.
  - `orca terminal [create|list|kill|attach]`: PTY lifecycle management.
  - `orca worktree [create|list|remove]`: Git worktree orchestration.
- Connects to local `orcad` daemon via Named Pipe / Unix Socket with sub-5ms cold-start latency.
- Auto-spawns `orcad` in the background if the daemon is not already running.

---

## 4. Phase 2 Roadmap: Desktop Shell Migration (Tauri)

Once Phase 1 is validated and operational in production:
1. **`crates/orca-desktop`:** Create a Tauri v2 shell crate.
2. **Direct Crate Integration:** Import `orca-protocol`, `orca-pty`, and core modules directly as Rust library dependencies within Tauri, removing IPC overhead between main process and PTYs.
3. **Renderer Preservation:** Point Tauri to the existing Vite/React bundle (`src/renderer/`). Retain 100% of the UI (Tailwind, Radix, Monaco, Zustand state) without component rewrites.
4. **IPC Bridge:** Translate Electron `ipcRenderer.invoke` calls to Tauri `window.__TAURI__.core.invoke` commands mapped to Rust handlers.

---

## 5. Testing & Verification Plan

### 5.1 Contract Tests
- Write Rust unit tests in `crates/orca-protocol` that deserialize existing JSON and binary fixtures from `src/shared/rpc-contract/` and `src/shared/terminal-stream-protocol.test.ts`.
- Ensure round-trip serialization identity (`Rust Struct -> JSON -> TypeScript Zod Validator -> OK`).

### 5.2 OS & PTY Integrity Tests
- **MSYS Breakaway Prevention Test:** On Windows, spawn Git Bash running a background process tree and verify membership via `QueryInformationJobObject`. Verify `terminate_pty_job()` reaps all descendant processes completely.
- **POSIX Process Group Test:** On Linux/macOS, verify `kill(-pgid, SIGTERM)` terminates processes and children.

### 5.3 Smoke & Parity Gates
- Run existing smoke test script against the Rust daemon:
  ```bash
  node config/scripts/runtime-serve-terminal-smoke.mjs --target orcad --daemon-bin ./target/release/orcad
  ```
- Run performance benchmarks:
  ```bash
  pnpm run bench:daemon-coldstart
  pnpm run bench:idle-cpu
  ```
- Validate that the running Electron application connects to the Rust `orcad` daemon, creates terminal tabs, streams output, and lists agents with zero functional regressions.
