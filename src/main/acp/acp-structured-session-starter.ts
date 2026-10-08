import { ACP_REOPEN_FAILED, acpReopenTakeover } from './acp-session-reopen-failure'
import type { AcpStructuredConnection } from './acp-structured-connection'
import type { AcpStructuredLane } from './acp-structured-lane'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'
import type { StructuredAgentSessionAcquireInput } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

export type AcpStartedSession = Awaited<ReturnType<AcpStructuredConnection['start']>>
export type AcpReopenTakeoverResult = ReturnType<typeof acpReopenTakeover>

export async function startOrResumeAcpSession(input: {
  connection: AcpStructuredConnection
  launch: AcpStructuredLaunch
  authMethodId?: string
  makeLane: (providerSessionId: string, attaching?: boolean) => AcpStructuredLane
  slot: { lane: AcpStructuredLane | null; reattaching: boolean }
  sessionId: string
  now: () => number
  acquire: StructuredAgentSessionAcquireInput
  deps: AcpStructuredSessionAdapterDeps
}): Promise<{
  started: AcpStartedSession
  liveLane: AcpStructuredLane
  takeover: AcpReopenTakeoverResult | null
}> {
  const { connection, launch, authMethodId, makeLane, slot, sessionId, now, acquire, deps } = input
  const auth = authMethodId ? { authMethodId } : {}
  let started: AcpStartedSession | null = null
  let liveLane: AcpStructuredLane | null = null
  let takeover: AcpReopenTakeoverResult | null = null

  if (launch.resume) {
    const resume = launch.resume
    const attaching = makeLane(resume.sessionId, true)
    liveLane = attaching
    try {
      started = await connection.start({
        cwd: launch.cwd,
        mcpServers: [],
        sessionId: resume.sessionId,
        ...auth
      })
      slot.reattaching = false
      attaching.translator.finishLoad()
    } catch (error) {
      takeover = acpReopenTakeover(error, resume, {
        over: connection.closed || acquire.signal?.aborted === true,
        now: now(),
        warn: (fields) => deps.logger?.warn(ACP_REOPEN_FAILED, { ...fields, sessionId })
      })
    }
  }

  if (!started || !liveLane) {
    liveLane?.dispose()
    slot.lane = null
    started = await connection.start({ cwd: launch.cwd, mcpServers: [], ...auth })
    liveLane = makeLane(started.sessionId)
  }

  return { started, liveLane, takeover }
}
