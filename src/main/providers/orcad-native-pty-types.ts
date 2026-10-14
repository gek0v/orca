export type OrcadNativePtyProviderOptions = {
  endpoint?: string
  binaryPath?: string
  spawnDaemonIfMissing?: boolean
}

export type ActiveOrcadPtyRecord = {
  id: string
  incarnationId: string
  pid: number | null
  cols: number
  rows: number
  cwd: string
  command?: string
  launchAgent?: string
}
