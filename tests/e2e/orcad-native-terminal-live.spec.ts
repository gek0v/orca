import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  getTerminalContent,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { splitMarkerEchoCommand } from './terminal-marker-echo-command'

test.use({
  orcaAppExtraEnv: {
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_USE_NATIVE_ORCAD: '1'
  }
})

declare global {
  var __localPtyProvider: { isOrcadNative?: boolean } | undefined
}

test('Electron desktop adopts OrcadNativePtyProvider and handles live interactive terminal IO', async ({
  electronApp,
  orcaPage
}) => {
  // Step 1: Prove OrcadNativePtyProvider was adopted by the main process
  const isOrcadNative = await electronApp.evaluate(() => {
    return globalThis.__localPtyProvider?.isOrcadNative
  })
  expect(isOrcadNative).toBe(true)

  // Step 2: Wait for desktop UI session and active worktree
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)

  // Step 3: Wait for active PTY pane backed by the native daemon
  const ptyId = await waitForActivePanePtyId(orcaPage)
  expect(ptyId).toBeTruthy()

  const hasPtyInBackend = await orcaPage.evaluate((id) => window.api.pty.hasPty(id), ptyId)
  expect(hasPtyInBackend).toBe(true)

  // Step 4: Wait for shell to produce initial output/prompt before issuing commands
  await expect
    .poll(async () => (await getTerminalContent(orcaPage)).length, {
      message: 'Terminal should produce initial shell prompt output'
    })
    .toBeGreaterThan(0)

  // Step 5: Execute a command in the terminal pane backed by orcad
  const prefix = `ORCAD_E2E_${Date.now()}`
  const suffix = '_PROVED'
  const marker = `${prefix}${suffix}`
  await execInTerminal(orcaPage, ptyId, splitMarkerEchoCommand(prefix, suffix))

  // Step 6: Verify terminal receives output rendered from orcad
  await waitForTerminalOutput(orcaPage, marker, 20_000)
})
