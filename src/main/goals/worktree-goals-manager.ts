import path from 'node:path'
import { WorktreeGoalsService } from './worktree-goals-service'

export class WorktreeGoalsManager {
  private readonly services = new Map<string, WorktreeGoalsService>()

  getService(workspacePath: string): WorktreeGoalsService {
    const normalized = path.resolve(workspacePath)
    let service = this.services.get(normalized)
    if (!service) {
      service = new WorktreeGoalsService(normalized)
      this.services.set(normalized, service)
    }
    return service
  }

  disposeService(workspacePath: string): void {
    const normalized = path.resolve(workspacePath)
    const service = this.services.get(normalized)
    if (service) {
      service.dispose()
      this.services.delete(normalized)
    }
  }

  disposeAll(): void {
    for (const service of this.services.values()) {
      service.dispose()
    }
    this.services.clear()
  }
}

export const worktreeGoalsManager = new WorktreeGoalsManager()
