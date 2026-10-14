# Handoff Report: Forensic Audit Remediation for Orcad Integration Test Timeout

**Investigation**: Root Cause Analysis and Remediation for Milestone 2 Integration Test Failure (`connects to real compiled orcad.exe binary and executes a command` timeout waiting for PTY exit)
**Investigator**: `explorer_m2_fix_2`
**Target Files**:

- `src/main/providers/orcad-pty-spawn-plan.ts`
- `src/main/providers/orcad-native-pty-provider.integration.test.ts`
- `crates/orca-pty/src/windows.rs`
- `src/main/providers/windows-shell-args.ts`

---

## 1. Observation

### Observation 1: Live Integration Test Timeout Failure During Forensic Audit

File: `teamwork_preview_auditor_m2_1/handoff.md`, lines 113-130:
Command executed: `pnpm test src/main/providers/orcad-native-pty-provider.integration.test.ts`
Verbatim output:

```text
 FAIL   bun  src/main/providers/orcad-native-pty-provider.integration.test.ts > OrcadNativePtyProvider Live Integration > connects to real compiled orcad.exe binary and executes a command
Error: PTY exit timed out
 ❯ src/main/providers/orcad-native-pty-provider.integration.test.ts:72:28
     70|         exitPromise,
     71|         new Promise<number>((_, reject) =>
     72|           setTimeout(() => reject(new Error('PTY exit timed out')), 5000)
       |                            ^
     73|         )
     74|       ])
```

### Observation 2: Flawed Spawn Plan Logic in `src/main/providers/orcad-pty-spawn-plan.ts`

Lines 18-35 of `src/main/providers/orcad-pty-spawn-plan.ts`:

```ts
if (process.platform === 'win32') {
  const defaultShell = process.env.COMSPEC || 'cmd.exe'
  const shellPath = opts.shellOverride || defaultShell
  const defaultCwd = homedir()
  const resolved = resolveWindowsShellLaunchArgs(
    shellPath,
    rawCwd,
    defaultCwd,
    undefined,
    opts.command
  )
  command = shellPath
  args = [...resolved.shellArgs]
  if (opts.terminalShellArgs && opts.terminalShellArgs.length > 0 && !opts.command) {
    args.push(...opts.terminalShellArgs)
  }
  cwd = resolved.effectiveCwd
}
```

Contrast with Unix handling on lines 36-44 of the same file:

```ts
  } else {
    const defaultShell = process.env.SHELL || '/bin/sh'
    command = opts.shellOverride || opts.command || defaultShell
    args = opts.terminalShellArgs || []
    if (opts.command && opts.shellOverride) {
      command = opts.shellOverride
      args = ['-c', opts.command]
    }
    cwd = rawCwd
  }
```

On Unix, `args = opts.terminalShellArgs || []`.
On Windows, `args = [...resolved.shellArgs]`, followed by `args.push(...opts.terminalShellArgs)`.

### Observation 3: Argument Generation in `src/main/providers/windows-shell-args.ts`

Lines 185-198 of `src/main/providers/windows-shell-args.ts`:

```ts
if (shellBasename === 'cmd.exe') {
  const shellArgStartupCommand = getCmdShellArgStartupCommand(startupCommand)
  const startupCommands = [
    CMD_UTF8_SETUP_COMMAND,
    ...(codexLaunchPreflightCommand ? [CMD_CODEX_LAUNCH_PREFLIGHT] : []),
    ...(shellArgStartupCommand ? [shellArgStartupCommand] : [])
  ]
  return {
    shellArgs: ['/K', startupCommands.join(' & ')],
    ...(shellArgStartupCommand ? { startupCommandDeliveredInShellArgs: true } : {}),
    effectiveCwd: nativeCwd,
    validationCwd: nativeCwd
  }
}
```

When `opts.command` is undefined, `resolved.shellArgs` is `['/K', 'chcp 65001 > nul']`.

### Observation 4: Windows ConPTY Command Line Construction in `crates/orca-pty`

Lines 116-125 of `crates/orca-pty/src/windows.rs`:

```rust
        let mut cmd_line_str =
            if command_to_spawn.contains(' ') && !command_to_spawn.starts_with('"') {
                format!("\"{}\"", command_to_spawn)
            } else {
                command_to_spawn
            };
        for arg in &args_to_spawn {
            cmd_line_str.push(' ');
            cmd_line_str.push_str(arg);
        }
```

When `command` is `'cmd.exe'` and `args` is `['/K', 'chcp 65001 > nul', '/c', 'echo NATIVE_ORCAD_LIVE_SUCCESS']`, the command line passed to `CreateProcessW` is:
`cmd.exe /K chcp 65001 > nul /c echo NATIVE_ORCAD_LIVE_SUCCESS`.

### Observation 5: Empirical Output from `cmd.exe /K ...` Under ConPTY

When spawning `cmd.exe` with `['/K', 'chcp 65001 > nul', '/c', 'echo NATIVE_ORCAD_LIVE_SUCCESS']`:

```text
DATA: "\u001b[?9001h\u001b[?1004h"
DATA: "\u001b[?25l\u001b[2J\u001b[m\u001b[H\u001b]0;C:\\WINDOWS\\SYSTEM32\\cmd.exe - chcp  65001  /c echo NATIVE_ORCAD_LIVE_SUCCESS\u0007\u001b[?25h"
DATA: "\u001b[?25l\u001b[?9001l\u001b[?1004lFormato de parámetro incorrecto: /c\u001b[3;1HC:\\Users\\Geko\\orca\\workspaces\\orca-upstream\\main>"
```

- `chcp` receives parameter `/c` and errors with: `Formato de parámetro incorrecto: /c` ("Invalid parameter format: /c").
- `echo NATIVE_ORCAD_LIVE_SUCCESS` is never executed.
- `cmd.exe` stays alive at prompt `C:\Users\Geko\orca\workspaces\orca-upstream\main>` because of `/K`.
- If no input is sent, the process never exits, causing `exitPromise` to time out after 5000ms.
- If `provider.write(spawnRes.id, 'exit\r\n')` is sent, `expect(fullOutput).toContain('NATIVE_ORCAD_LIVE_SUCCESS')` matches ONLY because `cmd.exe` set the console window title via `\u001b]0;...cmd.exe - chcp  65001  /c echo NATIVE_ORCAD_LIVE_SUCCESS\u0007`, not because the command ever ran.

### Observation 6: Empirical Execution of Clean `cmd.exe /c` Under ConPTY

When spawning `cmd.exe` directly with `args: ['/c', 'echo NATIVE_ORCAD_LIVE_SUCCESS']`:

```text
DATA: "\u001b[?9001h\u001b[?1004h"
DATA: "\u001b[?25l\u001b[2J\u001b[m\u001b[HNATIVE_ORCAD_LIVE_SUCCESS\r\n\u001b]0;C:\\WINDOWS\\SYSTEM32\\cmd.exe\u0007\u001b[?25h"
DATA: "\u001b[?9001l\u001b[?1004l"
EXIT: { id: "term-1", code: 0 }
```

- Output contains `NATIVE_ORCAD_LIVE_SUCCESS\r\n` directly on stdout.
- `cmd.exe` terminates automatically with code `0`.
- Execution time: ~45ms.
- Zero timeouts.

---

## 2. Logic Chain

1. In `src/main/providers/orcad-native-pty-provider.integration.test.ts`, the test intends to verify end-to-end command execution against the compiled native daemon (`orcad.exe`). On Windows it sets `shellOverride: 'cmd.exe'` and `terminalShellArgs: ['/c', 'echo NATIVE_ORCAD_LIVE_SUCCESS']`.
2. In `src/main/providers/orcad-pty-spawn-plan.ts` lines 22-34, when `opts.terminalShellArgs` is supplied, the plan invokes `resolveWindowsShellLaunchArgs('cmd.exe', ...)`, which returns `['/K', 'chcp 65001 > nul']`.
3. The spawn plan then appends `opts.terminalShellArgs` after `/K`, constructing `['/K', 'chcp 65001 > nul', '/c', 'echo NATIVE_ORCAD_LIVE_SUCCESS']`.
4. In Windows command prompt (`cmd.exe`), `/K` instructs the shell to execute the command following `/K` and remain open interactively (`/K` and `/c` are mutually exclusive). ConPTY joins args with spaces, making `chcp` consume `/c` as an invalid switch and keeping `cmd.exe` alive at the prompt.
5. In the original integration test, `exitPromise` waited for `provider.onExit`. Because `/K` kept `cmd.exe` alive, `onExit` never fired, resulting in `Error: PTY exit timed out` after 5000ms.
6. Attempting to band-aid the test by adding `provider.write(spawnRes.id, 'exit\r\n')` did not fix the root cause: `chcp` still crashed, `echo` never ran, and the string was only present in an OSC 0 terminal title escape sequence.
7. The proper fix is in `orcad-pty-spawn-plan.ts`: when `opts.terminalShellArgs` is explicitly provided by the caller (and `!opts.command`), `args` must be set directly to `[...opts.terminalShellArgs]`, exactly like Unix does on line 38 (`args = opts.terminalShellArgs || []`).
8. With this fix, `cmd.exe /c echo NATIVE_ORCAD_LIVE_SUCCESS` runs the command cleanly, prints the output to stdout, and terminates automatically with exit code 0 in ~50ms, resolving the timeout completely and permanently.

---

## 3. Caveats

- For standard interactive Orca terminal panes, `terminalShellArgs` is `undefined` (or empty), so `args` will continue to evaluate to `[...resolved.shellArgs]` (`['/K', 'chcp 65001 > nul']` for cmd.exe, or `-EncodedCommand` for PowerShell). Interactive shells in the Orca UI will remain interactive as intended.
- `terminalShellArgs` is only used when the caller explicitly specifies custom shell arguments, which is what integration tests, headless runners, and custom profiles require.
- As an explorer agent, I am read-only and have not modified `orcad-pty-spawn-plan.ts` or `orcad-native-pty-provider.integration.test.ts`. The implementation worker must apply the specified changes.

---

## 4. Conclusion

The timeout failure in `orcad-native-pty-provider.integration.test.ts` is caused by `orcad-pty-spawn-plan.ts` unconditionally prepending interactive arguments (`/K chcp 65001 > nul`) to `terminalShellArgs` on Windows.

### Required Code Changes (for Implementer Worker)

#### 1. In `src/main/providers/orcad-pty-spawn-plan.ts`

Replace lines 29-33:

```ts
<<<<
    command = shellPath
    args = [...resolved.shellArgs]
    if (opts.terminalShellArgs && opts.terminalShellArgs.length > 0 && !opts.command) {
      args.push(...opts.terminalShellArgs)
    }
====
    command = shellPath
    args =
      opts.terminalShellArgs && opts.terminalShellArgs.length > 0 && !opts.command
        ? [...opts.terminalShellArgs]
        : [...resolved.shellArgs]
>>>>
```

#### 2. In `src/main/providers/orcad-native-pty-provider.integration.test.ts`

Line 69 (`provider.write(spawnRes.id, 'exit\r\n')`) should be removed because `cmd.exe /c` (and `sh -c`) automatically terminates upon command completion. The clean test sequence is:

```ts
const cmd = process.platform === 'win32' ? 'cmd.exe' : 'sh'
const args =
  process.platform === 'win32'
    ? ['/c', 'echo NATIVE_ORCAD_LIVE_SUCCESS']
    : ['-c', 'echo NATIVE_ORCAD_LIVE_SUCCESS']

const spawnRes = await provider.spawn({
  shellOverride: cmd,
  terminalShellArgs: args,
  cols: 80,
  rows: 24,
  cwd: process.cwd()
})

expect(spawnRes.id).toBeDefined()
expect(spawnRes.pid).toBeTypeOf('number')

const code = await Promise.race([
  exitPromise,
  new Promise<number>((_, reject) =>
    setTimeout(() => reject(new Error('PTY exit timed out')), 5000)
  )
])

expect(code).toBe(0)
const fullOutput = outputChunks.join('')
expect(fullOutput).toContain('NATIVE_ORCAD_LIVE_SUCCESS')
```

---

## 5. Verification Method

To verify the fix after implementation:

```powershell
# 1. Run the live integration test (must complete in < 500ms with 1 passed test):
pnpm test src/main/providers/orcad-native-pty-provider.integration.test.ts

# 2. Run all provider and init tests:
pnpm test src/main/providers/orcad-native-pty-provider.test.ts src/main/daemon/daemon-provider-init.test.ts config/scripts/electron-builder-native-resources.test.mjs

# 3. Verify TypeScript typechecking:
pnpm tc

# 4. Run goal validation:
node out/cli/index.js goal validate
```

**Invalidation Conditions**:

- If `pnpm test src/main/providers/orcad-native-pty-provider.integration.test.ts` fails or exceeds 1000ms.
- If `fullOutput` does not contain `NATIVE_ORCAD_LIVE_SUCCESS`.
- If interactive Orca terminal spawns in `orcad-native-pty-provider.test.ts` fail or exit prematurely.
