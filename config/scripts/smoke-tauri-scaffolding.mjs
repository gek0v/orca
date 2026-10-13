#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { describeProcessFailure, runProcessSync } from './script-child-process.mjs'

const root = resolve(import.meta.dirname, '../..')
const manifestPath = join(root, 'src-tauri', 'Cargo.toml')
const configPath = join(root, 'src-tauri', 'tauri.conf.json')
const capabilitiesPath = join(root, 'src-tauri', 'capabilities', 'default.json')

console.log('[smoke:tauri] Verifying configuration files...')

if (!existsSync(manifestPath)) {
  console.error(`[smoke:tauri] Missing workspace manifest: ${manifestPath}`)
  process.exit(1)
}

if (!existsSync(configPath)) {
  console.error(`[smoke:tauri] Missing Tauri config: ${configPath}`)
  process.exit(1)
}

if (!existsSync(capabilitiesPath)) {
  console.error(`[smoke:tauri] Missing default capabilities: ${capabilitiesPath}`)
  process.exit(1)
}

try {
  JSON.parse(readFileSync(configPath, 'utf8'))
  JSON.parse(readFileSync(capabilitiesPath, 'utf8'))
} catch (error) {
  console.error('[smoke:tauri] Failed to parse JSON config or capability file:', error)
  process.exit(1)
}

console.log('[smoke:tauri] Running cargo check on src-tauri workspace...')
const checkResult = runProcessSync({
  program: 'cargo',
  args: ['check', '--manifest-path', manifestPath],
  cwd: root
})

if (checkResult.code !== 0) {
  console.error('[smoke:tauri] cargo check failed:', describeProcessFailure(checkResult))
  process.exit(checkResult.code ?? 1)
}

console.log('[smoke:tauri] Running cargo test on src-tauri workspace...')
const testResult = runProcessSync({
  program: 'cargo',
  args: ['test', '--manifest-path', manifestPath],
  cwd: root
})

if (testResult.code !== 0) {
  console.error('[smoke:tauri] cargo test failed:', describeProcessFailure(testResult))
  process.exit(testResult.code ?? 1)
}

console.log('[smoke:tauri] All smoke checks passed successfully!')
