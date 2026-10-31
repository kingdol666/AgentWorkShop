import type { AgentWorkspace } from '../agent-interface'
import type { AgentSessionEvent } from '../adapters/omp-rpc-client'
import { toolArgsPreview } from '../prompt-builder'

/** Compact, history-compatible audit line for a host tool used during lead supervision. */
export function supervisionToolHistoryMessage(event: AgentSessionEvent): string | null {
  const toolName = typeof event.toolName === 'string' && event.toolName ? event.toolName : 'tool'
  if (event.type === 'tool_execution_start') {
    return `🔧 ${toolName}${toolArgsPreview(event.args)}`
  }
  if (event.type !== 'tool_execution_end') return null

  const rawResult = event.result ?? event.output ?? ''
  let summary: string
  if (typeof rawResult === 'string') {
    summary = rawResult
  }
  else {
    try {
      summary = JSON.stringify(rawResult) ?? ''
    }
    catch {
      summary = '(不可序列化结果)'
    }
  }
  summary = summary.slice(0, 300)
  return `🔧 ${toolName} ${event.isError === true ? '❌ 失败' : '✅ 完成'}${summary ? `: ${summary}` : ''}`
}

/** Persist a supervisor host-tool event against the active root task when it is still open. */
export async function recordSupervisionToolHistory(
  workspace: Pick<AgentWorkspace, 'reportTask'>,
  taskId: string,
  event: AgentSessionEvent,
): Promise<void> {
  const message = supervisionToolHistoryMessage(event)
  if (message) await workspace.reportTask({ taskId, message })
}
