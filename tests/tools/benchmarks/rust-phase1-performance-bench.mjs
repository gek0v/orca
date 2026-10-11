#!/usr/bin/env node
/**
 * Rust Migration Phase 1 Performance & Memory Benchmark.
 *
 * Compares:
 * 1. CLI cold-start latency: `dist/bin/orca.exe` vs `node out/cli/index.js`
 * 2. Daemon memory footprint (WorkingSet / RSS): `orcad.exe` vs Node runtime
 * 3. Terminal PTY spawn latency & round-trip I/O throughput over Named Pipe
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import readline from 'node:readline'

const scriptDir = import.meta.dirname
const rootDir = path.resolve(scriptDir, '../../..')
const orcaBin = path.join(rootDir, 'dist/bin/orca.exe')
const orcadBin = path.join(rootDir, 'dist/bin/orcad.exe')
const nodeCli = path.join(rootDir, 'out/cli/index.js')
const resultsDir = path.join(scriptDir, 'results')

function getWorkingSetMB(pid) {
  try {
    const raw = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`],
      { encoding: 'utf8', timeout: 5000 }
    ).trim()
    const bytes = Number(raw)
    if (Number.isFinite(bytes)) {
      return Number((bytes / (1024 * 1024)).toFixed(2))
    }
  } catch {
    // Process might have terminated
  }
  return null
}

function calculateStats(samples) {
  if (samples.length === 0) {
    return { min: 0, max: 0, mean: 0, median: 0, p95: 0 }
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const min = sorted[0]
  const max = sorted.at(-1) ?? min
  const sum = sorted.reduce((acc, v) => acc + v, 0)
  const mean = sum / sorted.length
  const median = sorted[Math.floor(sorted.length * 0.5)]
  const p95 = sorted[Math.floor(sorted.length * 0.95)]
  return {
    min: Number(min.toFixed(2)),
    max: Number(max.toFixed(2)),
    mean: Number(mean.toFixed(2)),
    median: Number(median.toFixed(2)),
    p95: Number(p95.toFixed(2))
  }
}

function runCommandTimed(bin, args, cwd = rootDir) {
  const t0 = performance.now()
  const res = spawnSync(bin, args, { cwd, encoding: 'utf8', shell: false })
  const elapsed = performance.now() - t0
  return { elapsed, success: res.status === 0, stdout: res.stdout, stderr: res.stderr }
}

async function benchmarkCliColdStart() {
  console.log('\n============================================================')
  console.log(' 1. CLI COLD-START LATENCY BENCHMARK')
  console.log('============================================================')

  // Warmup
  runCommandTimed(orcaBin, ['--version'])
  runCommandTimed(process.execPath, [nodeCli, '--version'])

  const ITERATIONS = 30
  const orcaVersionSamples = []
  const nodeVersionSamples = []
  const orcaHelpSamples = []
  const nodeHelpSamples = []

  console.log(`Running ${ITERATIONS} iterations for --version and --help...`)

  for (let i = 0; i < ITERATIONS; i++) {
    orcaVersionSamples.push(runCommandTimed(orcaBin, ['--version']).elapsed)
    nodeVersionSamples.push(runCommandTimed(process.execPath, [nodeCli, '--version']).elapsed)
    orcaHelpSamples.push(runCommandTimed(orcaBin, ['--help']).elapsed)
    nodeHelpSamples.push(runCommandTimed(process.execPath, [nodeCli, '--help']).elapsed)
  }

  const orcaVersionStats = calculateStats(orcaVersionSamples)
  const nodeVersionStats = calculateStats(nodeVersionSamples)
  const orcaHelpStats = calculateStats(orcaHelpSamples)
  const nodeHelpStats = calculateStats(nodeHelpSamples)

  console.log('\n[CLI --version Results (ms)]')
  console.table({
    'Native Rust (orca.exe)': orcaVersionStats,
    'Node.js CLI (out/cli)': nodeVersionStats
  })
  const versionSpeedup = (nodeVersionStats.median / orcaVersionStats.median).toFixed(1)
  console.log(
    `--> Native Rust CLI is ${versionSpeedup}x FASTER (median ${orcaVersionStats.median}ms vs ${nodeVersionStats.median}ms)`
  )

  console.log('\n[CLI --help Results (ms)]')
  console.table({
    'Native Rust (orca.exe)': orcaHelpStats,
    'Node.js CLI (out/cli)': nodeHelpStats
  })
  const helpSpeedup = (nodeHelpStats.median / orcaHelpStats.median).toFixed(1)
  console.log(
    `--> Native Rust CLI is ${helpSpeedup}x FASTER (median ${orcaHelpStats.median}ms vs ${nodeHelpStats.median}ms)`
  )

  return {
    version: { orca: orcaVersionStats, node: nodeVersionStats, speedup: `${versionSpeedup}x` },
    help: { orca: orcaHelpStats, node: nodeHelpStats, speedup: `${helpSpeedup}x` }
  }
}

async function benchmarkDaemonAndTerminal() {
  console.log('\n============================================================')
  console.log(' 2. DAEMON MEMORY & TERMINAL PTY BENCHMARK')
  console.log('============================================================')

  const pipeName = `\\\\.\\pipe\\orcad-bench-${Date.now()}`
  const orcad = spawn(orcadBin, ['--pipe', pipeName, '--idle-timeout', '120'], {
    stdio: ['ignore', 'pipe', 'pipe']
  })

  // Wait for daemon to be ready
  await new Promise((resolve, reject) => {
    let started = false
    const timeout = setTimeout(() => {
      if (!started) {
        reject(new Error('orcad startup timed out'))
      }
    }, 10000)

    const checkPipe = () => {
      const sock = net.connect(pipeName, () => {
        started = true
        clearTimeout(timeout)
        sock.end()
        resolve()
      })
      sock.on('error', () => {
        if (!started) {
          setTimeout(checkPipe, 50)
        }
      })
    }
    checkPipe()
  })

  console.log(`orcad daemon booted (PID: ${orcad.pid}) on pipe: ${pipeName}`)

  // Measure Idle Memory
  await new Promise((r) => setTimeout(r, 1000))
  const idleMemoryMB = getWorkingSetMB(orcad.pid)
  console.log(`\n[Memory Footprint]`)
  console.log(`  orcad (Rust Tokio) Idle WorkingSet: ${idleMemoryMB} MB`)

  // Baseline comparison with a clean Node.js instance
  const nodeSample = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {
    stdio: 'ignore'
  })
  await new Promise((r) => setTimeout(r, 1000))
  const nodeIdleMemoryMB = getWorkingSetMB(nodeSample.pid)
  nodeSample.kill()
  console.log(`  Node.js Baseline Idle WorkingSet:   ${nodeIdleMemoryMB} MB`)
  const memoryReduction = (((nodeIdleMemoryMB - idleMemoryMB) / nodeIdleMemoryMB) * 100).toFixed(1)
  console.log(`  --> Memory Reduction: ${memoryReduction}% less RAM consumed by Rust daemon`)

  // Benchmark IPC RPC ping and CLI client
  console.log('\n[IPC Roundtrip Latency (ms)]')
  const pingSamples = []
  for (let i = 0; i < 20; i++) {
    const res = runCommandTimed(orcaBin, ['ping', '--pipe', pipeName, '--json'])
    pingSamples.push(res.elapsed)
  }
  const pingStats = calculateStats(pingSamples)
  console.log(
    `  orca ping roundtrip (cold CLI + IPC pipe + daemon reply): median ${pingStats.median}ms, min ${pingStats.min}ms`
  )

  // Terminal PTY Interaction Benchmark over Named Pipe
  console.log('\n[Terminal PTY Lifecycle & Latency]')
  const clientSocket = net.connect(pipeName)
  await new Promise((r) => clientSocket.once('connect', r))

  const rl = readline.createInterface({ input: clientSocket })
  const pendingRequests = new Map()
  let markerFound = null
  let accumulatedOutput = ''

  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) {
      return
    }
    try {
      const msg = JSON.parse(trimmed)
      if (msg.id && pendingRequests.has(String(msg.id))) {
        const handler = pendingRequests.get(String(msg.id))
        pendingRequests.delete(String(msg.id))
        if (msg.error) {
          handler.reject(new Error(msg.error.message || 'RPC error'))
        } else {
          handler.resolve(msg.result)
        }
      } else if (msg.type === 'event' || msg.event === 'data') {
        if (msg.data) {
          accumulatedOutput += msg.data
          if (markerFound && accumulatedOutput.includes(markerFound.marker)) {
            markerFound.resolve()
          }
        }
      }
    } catch {
      // Ignore parse error
    }
  })

  let reqCount = 0
  function sendRpc(method, params = {}) {
    const id = `req_${++reqCount}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(id)
        reject(new Error(`sendRpc timeout for ${method}`))
      }, 10000)
      pendingRequests.set(id, {
        resolve: (val) => {
          clearTimeout(timer)
          resolve(val)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        }
      })
      clientSocket.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  // Measure PTY Creation Time
  const tPty0 = performance.now()
  const ptyResult = await sendRpc('terminal.create', {
    command: 'cmd.exe',
    args: [],
    cwd: rootDir,
    cols: 80,
    rows: 24
  })
  const ptyCreateElapsed = Number((performance.now() - tPty0).toFixed(2))
  const terminalId = ptyResult.terminalId || ptyResult.id
  console.log(
    `  ConPTY Creation Latency: ${ptyCreateElapsed}ms (Terminal ID: ${terminalId}, PID: ${ptyResult.pid})`
  )

  // Memory under active PTY
  await new Promise((r) => setTimeout(r, 500))
  const activeMemoryMB = getWorkingSetMB(orcad.pid)
  console.log(`  orcad WorkingSet with active ConPTY: ${activeMemoryMB} MB`)

  // Wait for initial shell prompt before issuing interactive command
  for (let i = 0; i < 30; i++) {
    if (accumulatedOutput.length > 0) {
      break
    }
    await new Promise((r) => setTimeout(r, 50))
  }

  // Measure I/O Roundtrip (echo marker)
  const marker = `BENCH_MARKER_${Date.now()}`
  const tIo0 = performance.now()
  let ioElapsed = 0

  const echoPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `PTY echo timed out after 10s. Received output: ${JSON.stringify(accumulatedOutput)}`
        )
      )
    }, 10000)
    markerFound = {
      marker,
      resolve: () => {
        clearTimeout(timer)
        ioElapsed = Number((performance.now() - tIo0).toFixed(2))
        resolve()
      }
    }
  })

  await sendRpc('terminal.input', { terminalId, data: `echo ${marker}\r\n` })
  await echoPromise
  console.log(`  PTY Interactive I/O Echo Roundtrip: ${ioElapsed}ms`)

  // Teardown PTY and Daemon
  await sendRpc('terminal.kill', { terminalId })
  rl.close()
  clientSocket.end()
  orcad.kill()

  return {
    memory: {
      orcadIdleMB: idleMemoryMB,
      nodeIdleMB: nodeIdleMemoryMB,
      orcadActivePtyMB: activeMemoryMB,
      reductionPercent: `${memoryReduction}%`
    },
    latency: {
      pingStats,
      ptyCreateMs: ptyCreateElapsed,
      ptyIoEchoRoundtripMs: ioElapsed
    }
  }
}

async function main() {
  console.log('Starting Orca Rust Migration Phase 1 Performance Benchmark Suite...')
  mkdirSync(resultsDir, { recursive: true })

  const cliResults = await benchmarkCliColdStart()
  const daemonResults = await benchmarkDaemonAndTerminal()

  const report = {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    cli: cliResults,
    daemon: daemonResults
  }

  const resultPath = path.join(resultsDir, 'rust-phase1-benchmark-results.json')
  writeFileSync(resultPath, JSON.stringify(report, null, 2))
  console.log(`\n============================================================`)
  console.log(`Benchmark complete. Full results written to:\n  ${resultPath}`)
  console.log(`============================================================\n`)
}

main().catch((err) => {
  console.error('Benchmark failed:', err)
  process.exit(1)
})
