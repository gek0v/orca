export type AntigravityPermissionDecision = 'allow' | 'deny' | 'ask'

export type AntigravityInteractiveApprover = (
  toolName: string,
  args?: Record<string, unknown>
) => Promise<boolean | 'allow' | 'deny' | 'ask'>

export type AntigravityPermissionBridgeOptions = {
  bypassPermissions?: boolean
  autoApproveReadOnly?: boolean
  interactiveApprover?: AntigravityInteractiveApprover
  timeoutMs?: number
}

const READ_ONLY_TOOLS = new Set([
  'view_file',
  'list_resources',
  'read_resource',
  'search_web',
  'read_url_content'
])

export function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOLS.has(toolName) || toolName.startsWith('get_')
}

export function buildDecisionPayload(decision: AntigravityPermissionDecision): string {
  return JSON.stringify({ decision })
}

export class AntigravityPermissionBridge {
  private bypassPermissions: boolean
  private autoApproveReadOnly: boolean
  private interactiveApprover?: AntigravityInteractiveApprover
  private readonly timeoutMs: number

  constructor(options?: AntigravityPermissionBridgeOptions) {
    this.bypassPermissions = options?.bypassPermissions ?? false
    this.autoApproveReadOnly = options?.autoApproveReadOnly ?? false
    this.interactiveApprover = options?.interactiveApprover
    this.timeoutMs = options?.timeoutMs ?? 5000
  }

  public setBypassPermissions(bypass: boolean): void {
    this.bypassPermissions = bypass
  }

  public setAutoApproveReadOnly(autoApprove: boolean): void {
    this.autoApproveReadOnly = autoApprove
  }

  public setInteractiveApprover(approver?: AntigravityInteractiveApprover): void {
    this.interactiveApprover = approver
  }

  /** Synchronous fast path for immediate permissions. Returns null if interactive resolution required. */
  public decideSync(
    toolName: string,
    _args?: Record<string, unknown>
  ): AntigravityPermissionDecision | null {
    if (this.bypassPermissions) {
      return 'allow'
    }

    if (this.autoApproveReadOnly && isReadOnlyTool(toolName)) {
      return 'allow'
    }

    if (!this.interactiveApprover) {
      return 'ask'
    }

    return null
  }

  /** Resolves permission decision, with fallback to ask on timeout or error. */
  public async decide(
    toolName: string,
    args?: Record<string, unknown>
  ): Promise<AntigravityPermissionDecision> {
    const immediate = this.decideSync(toolName, args)
    if (immediate !== null) {
      return immediate
    }

    if (!this.interactiveApprover) {
      return 'ask'
    }

    try {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeoutPromise = new Promise<AntigravityPermissionDecision>((resolve) => {
        timer = setTimeout(() => resolve('ask'), this.timeoutMs)
      })

      const approvalPromise = this.interactiveApprover(toolName, args).then((res) => {
        if (typeof res === 'boolean') {
          return res ? 'allow' : 'deny'
        }
        return res
      })

      const outcome = await Promise.race([approvalPromise, timeoutPromise])
      if (timer) {
        clearTimeout(timer)
      }
      return outcome
    } catch {
      return 'ask'
    }
  }
}
