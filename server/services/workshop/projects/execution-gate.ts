/**
 * Project 执行层硬门（B6）：注入面过滤之外的独立闸门。
 *
 * dispatch.ts 在插件/工业/任务分发之前调用；返回 null 表示放行。
 * ProjectService 未装配（单测/启动早期）时只拦 project 工具（mode=none 全拒）。
 */
import type { HostToolResult } from '../agents/host-tool-bridge/types'
import { getProjectService } from './service'
import { PROJECT_LEADER_TOOL_NAMES, projectToolCallVerdict } from './tool-surface'

export function projectExecutionGate(agentId: string, toolName: string): HostToolResult | null {
  let svc
  try {
    svc = getProjectService()
  }
  catch {
    svc = null
  }
  const pCtx = svc?.agentProjectContext(agentId) ?? null
  if (pCtx?.isLeader && !PROJECT_LEADER_TOOL_NAMES.has(toolName)) {
    svc?.recordToolRejection(pCtx.project.id, agentId, toolName, 'project_leader_tool_denied')
    return {
      text: `PROJECT_TOOL_DENIED: 项目总工只能使用项目级工具;${toolName} 不可用`,
      isError: true,
    }
  }
  const mode = pCtx ? (pCtx.isLeader ? 'leader' : pCtx.role === 'lead' ? 'channel_lead' : 'worker') : 'none'
  const verdict = projectToolCallVerdict(mode, toolName)
  if (!verdict.allowed) {
    if (pCtx) svc?.recordToolRejection(pCtx.project.id, agentId, toolName, verdict.code ?? 'project_tool_denied')
    return { text: `${verdict.code}: ${verdict.message}`, isError: true }
  }
  return null
}
