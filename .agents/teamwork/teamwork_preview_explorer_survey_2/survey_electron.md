# Technical Survey: Electron / TypeScript Terminal & IPC Layer

**Target:** Integration of Rust Native Daemon (`orcad`, `orca-pty`, `orca-protocol`) into Orca `main`  
**Explorer:** `survey_explorer_2`  
**Date:** 2026-10-12  
**Workspaces Inspected:**

- Main: `C:\Users\Geko\orca\workspaces\orca-upstream\main`
- MIgration: `C:\Users\Geko\orca\workspaces\orca-upstream\MIgration`

---

## Executive Summary

Orca's terminal subsystem in `main` is designed around the `IPtyProvider` interface, which decouples Electron UI handlers from concrete PTY implementations. In standard `main`, two providers exist: `LocalPtyProvider` (in-process fallback using `node-pty`) and `DaemonPtyAdapter` / `DaemonPtyRouter` (connecting to an out-of-process Node.js daemon). On Windows, this architecture causes severe UI hangs (**"Orca no responde"**) and high latency due to:

1. ConPTY execution and pipe draining running within single-threaded V8 runtimes.
2. V8 event loop starvation and garbage collection thrashing during high-volume terminal streaming (NDJSON parsing, string allocations, and Chromium IPC flooding).
3. The Electron main process thread failing to service the Win32 HWND message queue (`PeekMessage`/`DispatchMessage`).

In the `MIgration` worktree, a clean native integration was already prototyped and verified:

- Rust crates (`orcad`, `orca-pty`, `orca-protocol`, `orca-cli`) handle ConPTY, Tokio async I/O, Win32 Job Objects, and Named Pipe IPC (`\\.\pipe\orcad` or `\\.\pipe\orcad-desktop-${pid}`).
- A TypeScript provider `OrcadNativePtyProvider` (implementing `IPtyProvider`) and client `OrcadNativePtyClient` connect to `orcad` via Windows Named Pipe with zero dependency on `node-pty`.
- Benchmark measurements demonstrate **83.2% lower RAM** (6.3 MB vs 37.5 MB), **sub-millisecond echo latency** (0.56 ms), and **10.8x faster CLI startup** (6.0 ms vs 66 ms).
- An end-to-end headless Playwright test (`tests/e2e/orcad-native-terminal-live.spec.ts`) verifies live adoption and interactive terminal I/O.

This survey details the current `main` architecture, compares it with `MIgration`, catalogues the exact TypeScript/Electron modules requiring modification, outlines the performance and event loop mechanics, and specifies the IPC contracts.

---

## 1. Current Terminal & PTY Architecture in `main`

### 1.1 Provider Abstraction: `IPtyProvider`

Located in `src/main/providers/pty-provider-contract.ts` (and re-exported via `src/main/providers/types.ts`), `IPtyProvider` defines the contract for all terminal backends:

- Lifecycle: `spawn(opts: PtySpawnOptions): Promise<PtySpawnResult>`, `attach(id: string)`, `shutdown(id: string, opts)`
- I/O: `write(id: string, data: string): boolean`, `writeWithSettlement(id: string, data: string)`, `resize(id: string, cols: number, rows: number)`
- Flow Control: `pauseProducer?(id: string)`, `resumeProducer?(id: string)`, `setPtyBackgrounded?(id: string, bg: boolean)`
- State & Inspection: `getCwd(id: string)`, `getAppliedSize?(id: string)`, `hasPty?(id: string)`, `probePtyLiveness?(id: string)`, `listProcesses()`
- Event Subscriptions: `onData(callback: (payload: PtyDataEvent) => void)`, `onExit(callback: (payload) => void)`, `onWriteUnavailable?`

### 1.2 Provider Registration & Dynamic Routing

Located in `src/main/ipc/pty/provider/registry.ts`:

- Maintains `export let localProvider: IPtyProvider = new LocalPtyProvider()` and `sshProviders: Map<string, IPtyProvider>`.
- `getProvider(connectionId)` returns `localProvider` for local sessions (`connectionId == null`) or the corresponding SSH provider.
- `setLocalPtyProvider(provider: IPtyProvider)` allows hot-swapping the active local provider (e.g. from `LocalPtyProvider` to a daemon-backed provider).

### 1.3 Startup Lifecycle & Provider Handoff

Located in `src/main/daemon/daemon-provider-init.ts` and `src/main/daemon/daemon-provider-state.ts`:

1. Cold start begins with `localProvider = new LocalPtyProvider()` (in-process fallback).
2. Concurrently, `initDaemonPtyProvider()` runs:
   - Instantiates `DaemonSpawner`, which forks an out-of-process Node daemon (`out/main/index.js` or `src/main/daemon/server.ts`).
   - Node daemon binds to a Windows Named Pipe: `\\?\pipe\orca-terminal-host-v${protocolVersion}-${hash}`.
   - Instantiates `DaemonPtyAdapter`, establishes lifecycle lease.
   - Calls `installDaemonProvider(newSpawner, routedAdapter)` -> calls `replaceDaemonProvider(routedAdapter)` -> `setLocalPtyProvider(routedAdapter)`.
   - Calls `rebindLocalProviderListeners()`, which unbinds old listeners and hooks `session.acceptPtyDataForRenderer` to the newly installed provider's `onData` and `onExit`.

### 1.4 Electron IPC Registration & Bridge

- **Main IPC Handlers** (`src/main/ipc/pty/register-handlers.ts`):
  Registers handlers on `ipcMain`:
  - `pty:spawn`: resolves CWD, creates session, calls `provider.spawn(opts)`
  - `pty:write` & `pty:writeAccepted`: calls `provider.write(id, data)` / `provider.writeWithSettlement`
  - `pty:resize`: calls `provider.resize(id, cols, rows)`
  - `pty:kill`: calls `provider.shutdown(id, ...)`
  - `pty:hasPty`, `pty:listSessions`, `pty:getCwd`, `pty:getSize`, `pty:inspectProcess`
- **Streaming Pipeline**:
  - `bindProviderListeners(session)` (`src/main/ipc/pty/provider/bind-listeners.ts`) receives chunks from `localProvider.onData`.
  - Dispatches to `session.acceptPtyDataForRenderer(payload, outputSeq)` (`src/main/ipc/pty/delivery/accept.ts`).
  - Passes through `PtyPendingDataDrainQueue` and flow control checks.
  - Calls `session.mainWindow.webContents.send('pty:data', payload)` (`src/main/ipc/pty/delivery/payload.ts`).
- **Preload API** (`src/preload/api/pty-api.ts`):
  Exposes `window.api.pty` with typed methods (`spawn`, `write`, `resize`, `kill`, `onData`, `onExit`).
- **Renderer Consumption**:
  Components in `src/renderer` (e.g. xterm.js managers, tabs slice) consume `window.api.pty` to render interactive shells.

---

## 2. Prototyped Changes in `MIgration` Worktree

In `C:\Users\Geko\orca\workspaces\orca-upstream\MIgration`, a fully functional prototype was implemented across commits `915b9ec34e` through `b9b1ea8a12`:

### 2.1 Native Rust Subsystem

- **`crates/orca-protocol`**:
  - Implements `RuntimeRpcEnvelope<T>` and `RuntimeRpcRequest` for JSON-RPC 2.0.
  - Implements 16-byte fixed-header binary terminal stream framing (`TerminalStreamFrame`, `TerminalStreamOpcode`).
- **`crates/orca-pty`**:
  - Win32 ConPTY management via `CreatePseudoConsole`.
  - Enforces `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` without `JOB_OBJECT_LIMIT_BREAKAWAY_OK` on Win32 Job Objects.
  - Decoupled I/O: a dedicated OS thread (`orca-pty-reader`) continuously executes blocking `ReadFile` (8 KB buffer) and sends chunks through Tokio `mpsc::channel(256)`. Writing uses non-blocking `WriteFile` without acquiring reader locks.
  - POSIX PTY for Unix.
- **`crates/orcad`**:
  - Standalone Tokio async runtime daemon.
  - Listens on Windows Named Pipes (`\\.\pipe\orcad` or custom path) and Unix sockets.
  - Methods: `terminal.create`, `terminal.write`, `terminal.resize`, `terminal.shutdown`, `status.list`, `git.exec`.
  - Broadcasts line-delimited JSON events `{ type: 'event', event: 'data', terminalId, data }` and exit events `{ type: 'event', event: 'exit', terminalId, code }`.
- **`crates/orca-cli`**:
  - High-performance CLI using `clap`. Sub-5ms execution time.

### 2.2 Electron Integration in `MIgration`

1. **`src/main/providers/orcad-native-pty-client.ts`**:
   - Manages connection to the named pipe endpoint (defaults to `\\.\pipe\orcad-desktop-${process.pid}`).
   - If not connected, attempts to open pipe via `net.connect(endpoint)`. If not present, spawns `orcad.exe --pipe <endpoint> --idle-timeout 0` and retries connection.
   - Wraps socket in `readline.createInterface({ input: sock })`.
   - Dispatches JSON-RPC requests (`callRpc(method, params)`).
   - Emits parsed streaming events (`data` and `exit`).
2. **`src/main/providers/orcad-native-pty-provider.ts`**:
   - Implements `IPtyProvider`.
   - Tracks `activePtys: Map<string, ActivePtyRecord>`.
   - Implements `spawn()` by planning args with `buildOrcadPtySpawnPlan()` and invoking `client.callRpc('terminal.create', ...)`.
   - Implements `write()` and `writeWithSettlement()` invoking `client.callRpc('terminal.write', ...)`.
   - Implements `resize()` invoking `client.callRpc('terminal.resize', ...)`.
   - Implements `shutdown()` invoking `client.callRpc('terminal.shutdown', ...)`.
   - Forwards `onData` and `onExit` events to registered listeners.
   - Implements `getDaemonIdentity()`, `listProcesses()`, `getAppliedSize()`, `getCwd()`.
3. **`src/main/daemon/daemon-provider-init.ts`**:
   - Introduces `shouldAdoptNativeOrcadProvider()`:
     Checks `ORCA_DISABLE_NATIVE_ORCAD !== '1'`, `ORCA_USE_NATIVE_ORCAD === '1'`, or auto-detects presence of native `orcad.exe` binary.
   - When enabled, instantiates `OrcadNativePtyProvider`, connects, and directly executes:
     ```ts
     installDaemonProvider(null, nativeProvider)
     rebindLocalProviderListeners()
     ```
   - Gracefully falls back to legacy `DaemonSpawner` if native initialization fails.
4. **`src/main/orcad/orcad-local-serve-selection.ts`**:
   - Added `resolveNativeBinary()` scanning `bin/orcad.exe`, `dist/bin/orcad.exe`, `target/release/orcad.exe`, and environment variables `ORCAD_NATIVE_BIN` / `ORCAD_BIN`.
5. **Packaging Integration**:
   - `config/electron-builder.config.cjs` & `config/scripts/packaged-native-binaries.cjs` automatically bundle `orcad.exe` and `orca.exe` into the distribution app resources under `bin/`.

---

## 3. Exact Modules, Classes, and Interfaces to Modify in `main`

The following inventory identifies the exact files, classes, and interfaces that need modification or creation when integrating the native orcad daemon into `main`:

### 3.1 Files to Import / Create

| Path                                                               | Responsibility                                | Notes / Modifications Needed                                                                                                                                               |
| :----------------------------------------------------------------- | :-------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/providers/orcad-native-pty-client.ts`                    | IPC Named Pipe client to `orcad`              | **Refinement needed:** Use `spawnProcess` from `src/shared/child-process/spawn-process` instead of `child_process.spawn` to satisfy AGENTS.md Windows child process rules. |
| `src/main/providers/orcad-native-pty-provider.ts`                  | `IPtyProvider` implementation                 | **Refinement needed:** Expose `pauseProducer` / `resumeProducer` aliases matching `IPtyProvider` exact contract.                                                           |
| `src/main/providers/orcad-pty-spawn-plan.ts`                       | Parameter resolver for shell spawning         | Resolves shell path, args, CWD, and environment variables.                                                                                                                 |
| `src/main/providers/orcad-native-pty-provider.test.ts`             | Unit tests for provider lifecycle & I/O       | Mocks named pipe server, tests RPC lifecycle and event streaming.                                                                                                          |
| `src/main/providers/orcad-native-pty-provider.integration.test.ts` | Integration test against compiled `orcad.exe` | Runs live command in real orcad ConPTY.                                                                                                                                    |
| `src/main/daemon/daemon-provider-init.test.ts`                     | Tests for native adoption logic               | Tests `shouldAdoptNativeOrcadProvider` toggles.                                                                                                                            |
| `config/scripts/packaged-native-binaries.cjs`                      | Packaging helper for native binaries          | Resolves binary paths for `electron-builder`.                                                                                                                              |
| `config/scripts/electron-builder-native-resources.test.mjs`        | Tests for packaging resource helper           | Validates `.exe` resolution on Windows and ELF on Linux.                                                                                                                   |
| `tests/e2e/orcad-native-terminal-live.spec.ts`                     | Headless Playwright E2E test                  | Validates provider adoption and terminal echo in live Electron.                                                                                                            |

### 3.2 Files to Modify

| Path                                                  | Current State in `main`                                                   | Target Change                                                                                                                                                                                     |
| :---------------------------------------------------- | :------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/main/daemon/daemon-provider-init.ts`             | Spawns `DaemonSpawner` with Node daemon                                   | Add `shouldAdoptNativeOrcadProvider()`. If true, initialize `OrcadNativePtyProvider`, call `installDaemonProvider(null, nativeProvider)` and `rebindLocalProviderListeners()`. Fallback on error. |
| `src/main/daemon/daemon-provider-restart.ts`          | Restarts Node `DaemonSpawner`                                             | Handle `OrcadNativePtyProvider`: fan out synthetic exits (-1), dispose client, re-instantiate, reconnect, replace, and rebind.                                                                    |
| `src/main/daemon/daemon-provider-routing.ts`          | Union: `DaemonPtyRouter \| DaemonPtyAdapter \| DegradedDaemonPtyProvider` | Add `OrcadNativePtyProvider` to `DaemonProvider` type union; return `null` in `getCurrentDaemonAdapter()`.                                                                                        |
| `src/main/ipc/pty-management.ts`                      | Queries `getCurrentDaemonAdapter(provider)`                               | Guard against `OrcadNativePtyProvider`: return empty session list and delegate identity read directly to `provider.getDaemonIdentity()`.                                                          |
| `src/main/ipc/pty/provider/registry.ts`               | Sets `localProvider`                                                      | Expose `globalThis.__localPtyProvider` on `setLocalPtyProvider()` for runtime/test inspection.                                                                                                    |
| `src/main/local-builds/local-build-compatibility.ts`  | Calls adapter-specific methods                                            | Handle `provider instanceof OrcadNativePtyProvider`: query `provider.listProcesses()`.                                                                                                            |
| `src/main/memory/hydrate-local-pty-registry.ts`       | Reads sessions from daemon provider                                       | Return `false` early if `provider instanceof OrcadNativePtyProvider`.                                                                                                                             |
| `src/main/orcad/orcad-local-serve-selection.ts`       | Only handles `orcad` (Node) and `electron`                                | Add `resolveNativeBinary()` and return `{ kind: 'orcad-native', binary, version }`.                                                                                                               |
| `src/main/orcad/orcad-local-serve-selection-entry.ts` | Calls `selectServeRuntime`                                                | Pass `appRoot` into selection options.                                                                                                                                                            |
| `src/shared/orcad-local-serve-selection.ts`           | Type definitions for serve selection                                      | Add `{ kind: 'orcad-native'; binary: string; version: string }` to `ServeRuntimeSelection`.                                                                                                       |
| `src/cli/runtime/serve-orcad-launch.ts`               | Launches Node runtime entrypoint                                          | When `selection.kind === 'orcad-native'`, spawn `selection.binary` directly.                                                                                                                      |
| `config/electron-builder.config.cjs`                  | Configures `extraResources`                                               | Add `nativeOrcadResource('win32')` etc. to include `bin/orcad.exe` and `bin/orca.exe`.                                                                                                            |
| `package.json`                                        | Missing Rust build scripts                                                | Add `"build:native:rust": "cargo build --release -p orcad -p orca-cli"`.                                                                                                                          |

---

## 4. Performance & Event Loop Analysis ("Orca no responde")

### 4.1 The Windows Event Loop Starvation Mechanism

Windows determines application responsiveness via the desktop window manager (User32). If a process owning an active top-level HWND does not call `GetMessage()`, `PeekMessage()`, or `DispatchMessage()` for more than ~5 seconds, the OS flags the window as **"Not Responding"** (**"Orca no responde"**) and overlays a ghosting window.

In standard `main`:

1. **In-process ConPTY / Node Daemon:** `node-pty`ConPTY runs either directly in Electron's main process or in a child Node process.
2. **Synchronous C++ Native Addon Work:** `conpty.node` uses libuv async handles, but reading from ConPTY pseudo-console pipes under heavy traffic triggers rapid native callbacks into V8.
3. **V8 Heap Flood:** Heavy output bursts (e.g. `npm install`, compile loops, `git log`) generate tens of thousands of NDJSON strings in rapid succession.
4. **V8 Garbage Collection Freezes:** The sheer volume of short-lived string allocations trips frequent minor and major V8 GC sweeps (Stop-The-World).
5. **IPC Deserialization / Serialization Overhead:** `attachStreamEventReader` runs `decoder.write` and `parser.feed` with `JSON.parse` for every chunk on the main thread, immediately followed by `session.mainWindow.webContents.send('pty:data', payload)`.
6. **Result:** The Node/Electron main thread is completely saturated by I/O callbacks, parsing, and GC. The Win32 UI message queue is starved, resulting in the dreaded "Orca no responde" freeze.

### 4.2 How the Rust Architecture Solves the Freeze

1. **Total Out-of-Process Isolation (`orcad.exe`):**
   - The entire PTY subsystem, ConPTY initialization, child process management, and buffer management run in `orcad.exe`.
   - Electron's main process does not host `conpty.node` or execute pseudoconsole syscalls.
2. **Dedicated OS Reader Thread with Blocking Win32 `ReadFile`:**
   - In `orca-pty/src/windows.rs`, a dedicated native OS thread (`orca-pty-reader`) executes raw `ReadFile` on `pty_out_read` in an 8 KB buffer.
   - It does not touch libuv, V8, or any JavaScript event loop.
3. **Decoupled Asynchronous Tokio Channels & Kernel Backpressure:**
   - `orca-pty-reader` feeds an `mpsc::channel(256)`.
   - If the consumer is slow, the 256-chunk buffer fills and the OS thread blocks on `blocking_send`.
   - When the thread blocks, the OS pipe buffer fills up, exerting natural Win32 kernel backpressure on the spawned process (e.g. `cmd.exe`, `gcc`, `cargo`).
   - The spawned process pauses writing at the kernel level rather than consuming unbounded memory in userspace.
4. **Decoupled Input (Zero Mutex Contention):**
   - Input (`terminal.write`) uses a separate Win32 handle (`pty_in_write`) via `WriteFile`.
   - Interactive keystrokes (Ctrl+C, typing) execute without waiting on the reader thread or acquiring locks held by incoming output streams. Measured interactive latency is **0.56 ms**.
5. **Named Pipe Streaming via Win32 IOCP:**
   - Electron connects to `\\.\pipe\orcad...` using Node's `net.Socket`.
   - Node's `net.Socket` on Windows uses native I/O Completion Ports (IOCP) managed by libuv's background threadpool.
   - Chunks are received efficiently without polling.
6. **Strict Win32 Job Object Enforcement:**
   - `orca-pty` creates Job Objects with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and **without** `JOB_OBJECT_LIMIT_BREAKAWAY_OK`.
   - Children (including Git Bash/MSYS processes) cannot break away. When the session terminates, all descendants are instantly reaped by the Windows kernel, eliminating CPU-hogging orphan processes.

---

## 5. Electron IPC Contracts, Data Protocols & Error Handling

### 5.1 Electron Main <-> Renderer Contract (`window.api.pty`)

| IPC Channel            | Direction                 | Payload Shape                                                                      | Description                                                                                    |
| :--------------------- | :------------------------ | :--------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------- |
| `pty:spawn`            | Renderer -> Main (invoke) | `PtySpawnOptions` (`cols`, `rows`, `cwd`, `command`, `shellOverride`, `env`, etc.) | Spawns a new PTY session or reattaches. Returns `{ id, incarnationId, pid, shellReadyArmed }`. |
| `pty:write`            | Renderer -> Main (send)   | `(id: string, data: string, inputKind: TerminalInputKind)`                         | Unsettled fire-and-forget write to PTY stdin.                                                  |
| `pty:writeAccepted`    | Renderer -> Main (invoke) | `(id, data, inputKind, { requireWriteSettlement })`                                | Settled write returning `Promise<boolean>`.                                                    |
| `pty:resize`           | Renderer -> Main (send)   | `(id: string, cols: number, rows: number)`                                         | Resizes PTY cols and rows.                                                                     |
| `pty:kill`             | Renderer -> Main (invoke) | `(id: string, opts?: { keepHistory?: boolean })`                                   | Destroys PTY session.                                                                          |
| `pty:hasPty`           | Renderer -> Main (invoke) | `(id: string)` -> `Promise<boolean>`                                               | Checks PTY session existence.                                                                  |
| `pty:listSessions`     | Renderer -> Main (invoke) | `(scope?)` -> `Promise<PtyListedSession[]>`                                        | Lists all active PTY sessions.                                                                 |
| `pty:data`             | Main -> Renderer (send)   | `{ id: string, data: string, seq?: number, rawLength?: number }`                   | Terminal stdout/stderr stream to xterm.js.                                                     |
| `pty:exit`             | Main -> Renderer (send)   | `{ id: string, code: number, incarnationId?: string }`                             | Process exit notification.                                                                     |
| `pty:writeUnavailable` | Main -> Renderer (send)   | `{ id: string }`                                                                   | Signals that backend write channel died (triggers re-attach).                                  |

### 5.2 Electron Main <-> `orcad` Named Pipe Protocol

- **Transport:** Windows Named Pipe (`\\.\pipe\orcad-desktop-${pid}` or `\\.\pipe\orcad`) / Unix domain socket.
- **Framing:** Line-delimited UTF-8 JSON (`\n`).
- **RPC Requests (Electron -> orcad):**
  - `terminal.create`:
    ```json
    { "id": "req_1", "method": "terminal.create", "params": { "command": "cmd.exe", "args": [], "cols": 80, "rows": 24, "cwd": "C:\\...", "env": { ... } } }
    ```
    Response:
    ```json
    { "id": "req_1", "status": "success", "result": { "id": "term-1", "pid": 1234 } }
    ```
  - `terminal.write`:
    ```json
    {
      "id": "req_2",
      "method": "terminal.write",
      "params": { "terminalId": "term-1", "data": "echo hello\r\n" }
    }
    ```
  - `terminal.resize`:
    ```json
    {
      "id": "req_3",
      "method": "terminal.resize",
      "params": { "terminalId": "term-1", "cols": 120, "rows": 30 }
    }
    ```
  - `terminal.shutdown`:
    ```json
    { "id": "req_4", "method": "terminal.shutdown", "params": { "terminalId": "term-1" } }
    ```
- **Asynchronous Stream Events (orcad -> Electron):**
  - Output:
    ```json
    {
      "type": "event",
      "event": "data",
      "id": "term-1",
      "terminalId": "term-1",
      "data": "hello\r\n"
    }
    ```
  - Exit:
    ```json
    { "type": "event", "event": "exit", "id": "term-1", "terminalId": "term-1", "code": 0 }
    ```

### 5.3 Error Handling & Resilience Paths

1. **Daemon Missing on Electron Startup:**
   `OrcadNativePtyClient.ensureConnected()` attempts `tryOpenSocket()`. If connection fails and `spawnDaemonIfMissing` is true, it spawns `orcad.exe --pipe <pipe> --idle-timeout 0` and retries connection in a 30-attempt loop with 50 ms backoff (total budget: 1.5s).
2. **Daemon Crash / Pipe Disconnect:**
   When the socket closes unexpectedly:
   - `cleanupConnection()` rejects all in-flight RPC promises.
   - In `OrcadNativePtyProvider`, subsequent operations trigger `ensureConnected()`, which respawns `orcad.exe`.
   - If native init fails during cold start, `daemon-provider-init.ts` catches the error, logs `daemon-native-fallback`, and cleanly falls back to the legacy `DaemonSpawner`.
3. **Manual Daemon Restart (`daemon-provider-restart.ts`):**
   - Synthesizes `pty:exit` (-1) for all active sessions so the renderer does not hang waiting for dead processes.
   - Unbinds local provider listeners.
   - Disposes existing client and spawns fresh native provider.
   - Rebinds listeners and restores terminal routing.

---

## 6. Implementation Recommendations & Watchpoints

1. **Child Process Spawning Compliance (`AGENTS.md`):**
   In `src/main/providers/orcad-native-pty-client.ts`, do NOT use `node:child_process.spawn` directly. Use `spawnProcess` from `src/shared/child-process/spawn-process` to comply with Orca's cross-platform child process invariants (pins `windowsHide`, handles `.cmd` shims, prevents shell injection).
2. **Interface Parity in `OrcadNativePtyProvider`:**
   Add `pauseProducer(id: string)` and `resumeProducer(id: string)` to `OrcadNativePtyProvider` to ensure full compliance with `IPtyProvider`'s flow control contracts.
3. **Packaging Inclusion:**
   Verify `config/electron-builder.config.cjs` includes `bin/orcad.exe` and `bin/orca.exe` in `extraResources` for `build:win`, ensuring that packaged distribution builds bundle the compiled Rust binaries alongside the app.
4. **Cargo Build Target:**
   Ensure `cargo build --release -p orcad -p orca-cli` outputs to `target/release/orcad.exe` and that `dist/bin` or `bin` resolution logic finds it consistently in both development and production.
