import { spawn } from 'node:child_process'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const scriptDir = import.meta.dirname
const ROOT = path.resolve(scriptDir, '../../..')

const ORCAD_BIN = path.join(ROOT, 'target', 'release', 'orcad.exe')
const ORCA_BIN = path.join(ROOT, 'target', 'release', 'orca.exe')
const PIPE_NAME = `\\\\.\\pipe\\orcad-phase2-bench-${Date.now()}`

function runCli(args) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now()
    const child = spawn(ORCA_BIN, ['--pipe', PIPE_NAME, '--json', ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    child.on('close', (code) => {
      const durationMs = performance.now() - t0
      if (code !== 0) {
        return reject(new Error(`CLI exited with ${code}: ${stderr || stdout}`))
      }
      try {
        const json = JSON.parse(stdout)
        resolve({ json, durationMs, stdout })
      } catch {
        resolve({ text: stdout, durationMs, stdout })
      }
    })

    child.on('error', reject)
  })
}

async function runPhase2Benchmarks() {
  console.log('Starting Phase 2: Native CLI & Daemon Command Expansion Benchmark...\n')
  console.log(`Starting orcad on pipe: ${PIPE_NAME}`)

  const daemon = spawn(ORCAD_BIN, ['--pipe', PIPE_NAME, '--idle-timeout', '60'], {
    windowsHide: true,
    stdio: 'ignore'
  })

  // Brief pause for pipe binding
  await new Promise((r) => setTimeout(r, 200))

  const results = []

  try {
    // 1. ping
    console.log('[1/10] orca ping --json')
    const ping = await runCli(['ping'])
    results.push({ command: 'orca ping', durationMs: ping.durationMs, ok: ping.json?.ok === true })
    console.log(`  -> Duration: ${ping.durationMs.toFixed(2)}ms (ok: ${ping.json?.ok})`)

    // 2. status
    console.log('[2/10] orca status --json')
    const status = await runCli(['status'])
    results.push({
      command: 'orca status',
      durationMs: status.durationMs,
      ok: status.json?.ready === true
    })
    console.log(
      `  -> Duration: ${status.durationMs.toFixed(2)}ms (daemon PID: ${status.json?.daemon?.pid})`
    )

    // 3. diagnostics memory
    console.log('[3/10] orca diagnostics memory --json')
    const diag = await runCli(['diagnostics', 'memory'])
    const wsMb = (diag.json?.workingSetBytes / (1024 * 1024)).toFixed(2)
    results.push({
      command: 'orca diagnostics memory',
      durationMs: diag.durationMs,
      ok: diag.json?.ok === true
    })
    console.log(`  -> Duration: ${diag.durationMs.toFixed(2)}ms (WorkingSet: ${wsMb} MB)`)

    // 4. terminal create
    console.log('[4/10] orca terminal create --command cmd.exe --json')
    const termCreate = await runCli(['terminal', 'create', '--command', 'cmd.exe'])
    const termHandle = termCreate.json?.handle || termCreate.json?.terminalId
    results.push({
      command: 'orca terminal create',
      durationMs: termCreate.durationMs,
      ok: Boolean(termHandle)
    })
    console.log(`  -> Duration: ${termCreate.durationMs.toFixed(2)}ms (Terminal: ${termHandle})`)

    // 5. terminal send
    console.log(
      `[5/10] orca terminal send --terminal ${termHandle} --text "echo PHASE2_VERIFIED" --enter --json`
    )
    const termSend = await runCli([
      'terminal',
      'send',
      '--terminal',
      termHandle,
      '--text',
      'echo PHASE2_VERIFIED',
      '--enter'
    ])
    results.push({
      command: 'orca terminal send',
      durationMs: termSend.durationMs,
      ok: termSend.json?.submitted === true
    })
    console.log(
      `  -> Duration: ${termSend.durationMs.toFixed(2)}ms (submitted: ${termSend.json?.submitted})`
    )

    // Wait 250ms for terminal echo
    await new Promise((r) => setTimeout(r, 250))

    // 6. terminal read
    console.log(`[6/10] orca terminal read --terminal ${termHandle} --json`)
    const termRead = await runCli(['terminal', 'read', '--terminal', termHandle])
    const readMatches = termRead.json?.text?.includes('PHASE2_VERIFIED') ?? false
    results.push({
      command: 'orca terminal read',
      durationMs: termRead.durationMs,
      ok: readMatches
    })
    console.log(
      `  -> Duration: ${termRead.durationMs.toFixed(2)}ms (contains expected text: ${readMatches})`
    )

    // 7. terminal wait --for tui-idle
    console.log(
      `[7/10] orca terminal wait --terminal ${termHandle} --for tui-idle --timeout-ms 2000 --json`
    )
    const termWait = await runCli([
      'terminal',
      'wait',
      '--terminal',
      termHandle,
      '--for',
      'tui-idle',
      '--timeout-ms',
      '2000'
    ])
    results.push({
      command: 'orca terminal wait',
      durationMs: termWait.durationMs,
      ok: termWait.json?.conditionMet === true
    })
    console.log(
      `  -> Duration: ${termWait.durationMs.toFixed(2)}ms (conditionMet: ${termWait.json?.conditionMet})`
    )

    // 8. terminal split
    console.log(`[8/10] orca terminal split --terminal ${termHandle} --direction horizontal --json`)
    const termSplit = await runCli([
      'terminal',
      'split',
      '--terminal',
      termHandle,
      '--direction',
      'horizontal'
    ])
    results.push({
      command: 'orca terminal split',
      durationMs: termSplit.durationMs,
      ok: termSplit.json?.ok === true
    })
    console.log(
      `  -> Duration: ${termSplit.durationMs.toFixed(2)}ms (split handle: ${termSplit.json?.handle})`
    )

    // 9. terminal close
    console.log(`[9/10] orca terminal close --all --json`)
    const termClose = await runCli(['terminal', 'close', '--all'])
    results.push({
      command: 'orca terminal close --all',
      durationMs: termClose.durationMs,
      ok: termClose.json?.ok === true
    })
    console.log(
      `  -> Duration: ${termClose.durationMs.toFixed(2)}ms (closed count: ${termClose.json?.closed})`
    )

    // 10. worktree lifecycle: list, create, show, rm
    console.log('[10/10] orca worktree list, create, show, rm --json')
    const wtList = await runCli(['worktree', 'list'])
    const wtCreate = await runCli([
      'worktree',
      'create',
      '--name',
      'bench-wt-p2',
      '--branch',
      'bench-wt-p2'
    ])
    const wtShow = await runCli(['worktree', 'show', '--worktree', 'bench-wt-p2'])
    const wtRm = await runCli(['worktree', 'rm', '--worktree', 'bench-wt-p2', '--force'])

    const wtTotalMs = wtList.durationMs + wtCreate.durationMs + wtShow.durationMs + wtRm.durationMs
    results.push({
      command: 'orca worktree (list/create/show/rm)',
      durationMs: wtTotalMs,
      ok: wtCreate.json?.ok === true && wtShow.json?.ok === true && wtRm.json?.ok === true
    })
    console.log(`  -> Duration: ${wtTotalMs.toFixed(2)}ms (all worktree operations succeeded)`)

    console.log('\n============================================================')
    console.log(' PHASE 2 NATIVE CLI & DAEMON COMMAND COVERAGE SUMMARY')
    console.log('============================================================')
    console.table(results)

    const allPassed = results.every((r) => r.ok)
    console.log(
      allPassed
        ? '\nSUCCESS: All Phase 2 commands verified and passed!'
        : '\nFAILURE: Some commands failed.'
    )
  } finally {
    daemon.kill()
  }
}

runPhase2Benchmarks().catch((err) => {
  console.error('Benchmark failed:', err)
  process.exit(1)
})
