import type { PtyProcessInfo } from './types'
import type { ActiveOrcadPtyRecord } from './orcad-native-pty-types'

export class OrcadNativePtyState {
  private activePtys = new Map<string, ActiveOrcadPtyRecord>()

  get(id: string): ActiveOrcadPtyRecord | undefined {
    return this.activePtys.get(id)
  }

  set(id: string, record: ActiveOrcadPtyRecord): void {
    this.activePtys.set(id, record)
  }

  delete(id: string): boolean {
    return this.activePtys.delete(id)
  }

  has(id: string): boolean {
    return this.activePtys.has(id)
  }

  clear(): void {
    this.activePtys.clear()
  }

  entries(): IterableIterator<[string, ActiveOrcadPtyRecord]> {
    return this.activePtys.entries()
  }

  getActiveSessionIds(): string[] {
    return Array.from(this.activePtys.keys())
  }

  getCwd(id: string): string {
    return this.activePtys.get(id)?.cwd ?? ''
  }

  getForegroundProcess(id: string): string | null {
    return this.activePtys.get(id)?.launchAgent ?? null
  }

  getAppliedSize(id: string): { cols: number; rows: number } | null {
    const pty = this.activePtys.get(id)
    return pty ? { cols: pty.cols, rows: pty.rows } : null
  }

  updateDimensions(id: string, cols: number, rows: number): void {
    const pty = this.activePtys.get(id)
    if (pty) {
      pty.cols = cols
      pty.rows = rows
    }
  }

  listProcesses(): PtyProcessInfo[] {
    return Array.from(this.activePtys.values()).map((p) => ({
      id: p.id,
      incarnationId: p.incarnationId,
      rootProcessId: p.pid ?? undefined,
      cwd: p.cwd,
      title: ''
    }))
  }
}
