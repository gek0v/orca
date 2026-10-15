import { homedir } from 'node:os'
import { resolveWindowsShellLaunchArgs } from './windows-shell-args'
import type { PtySpawnOptions } from './types'

export type OrcadPtySpawnPlan = {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

export function buildOrcadPtySpawnPlan(opts: PtySpawnOptions): OrcadPtySpawnPlan {
  const rawCwd = opts.cwd || opts.prevalidatedCwd || process.cwd()
  let command: string
  let args: string[]
  let cwd: string

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
    args =
      opts.terminalShellArgs && opts.terminalShellArgs.length > 0 && !opts.command
        ? [...opts.terminalShellArgs]
        : [...resolved.shellArgs]
    cwd = resolved.effectiveCwd
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

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  if (opts.env) {
    Object.assign(env, opts.env)
  }
  if (opts.envToDelete) {
    for (const key of opts.envToDelete) {
      delete env[key]
    }
  }

  return { command, args, cwd, env }
}
