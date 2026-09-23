/**
 * 团队面(list_team_agents / get_queue_overview / create_team_agent / update_team_agent /
 * remove_team_agent)——原 dispatchHostTool 对应 case 的函数体按行搬运。
 */
import type { AgentWorkspace, AgentInfo } from '../../agent-interface'
import type { HostToolResult } from '../types'

export async function handleListTeamAgents(ws: AgentWorkspace): Promise<HostToolResult> {
  const agents = await ws.listAgents()
  const text = agents.map(a =>
    `  ${a.id} (${a.name}, role=${a.role}, harness=${a.harness})`,
  ).join('\n')
  return { text: `团队成员(${agents.length}):\n${text || '(空)'}` }
}

export async function handleGetQueueOverview(ws: AgentWorkspace): Promise<HostToolResult> {
  const overview = await ws.queueOverview()
  const lines = overview.map(s =>
    `  ${s.agentId} (${s.name}, role=${s.role}, state=${s.state}, current=${s.currentTaskId ?? '-'}${s.currentTaskTitle ? `「${s.currentTaskTitle}」` : ''}, progress=${s.currentTaskProgress ?? '-'}%, queued=${s.queuedCount}, completed=${s.completedCount})`,
  )
  return { text: `团队队列总览(${overview.length}):\n${lines.join('\n') || '(空)'}` }
}

export async function handleCreateTeamAgent(args: Record<string, unknown>, ws: AgentWorkspace): Promise<HostToolResult> {
  const name = args.name as string
  const harness = args.harness as string | undefined
  const systemPrompt = args.system_prompt as string | undefined
  const reason = args.reason as string | undefined
  const agent: AgentInfo = await ws.createTeamMember({
    name,
    harness,
    config: systemPrompt ? { systemPromptPrefix: systemPrompt } : undefined,
    reason,
  })
  return {
    text: [
      `团队成员已创建并加入 channel:`,
      `  id: ${agent.id}`,
      `  name: ${agent.name}(role=worker, harness=${agent.harness})`,
      `新成员当前空闲,可立即 dispatch_task 指派任务;list_team_agents 可随时查看团队名册。`,
    ].join('\n'),
  }
}

export async function handleUpdateTeamAgent(args: Record<string, unknown>, ws: AgentWorkspace): Promise<HostToolResult> {
  const agentId = args.agent_id as string
  const name = args.name as string | undefined
  const systemPrompt = args.system_prompt as string | undefined
  const enabled = args.enabled as boolean | undefined
  const reason = args.reason as string | undefined
  const agent = await ws.updateTeamMember(agentId, {
    name,
    config: systemPrompt !== undefined ? { systemPromptPrefix: systemPrompt } : undefined,
    enabled: enabled === undefined ? undefined : (enabled ? 1 : 0),
    reason,
  })
  return {
    text: `团队成员 ${agentId} 已更新:name="${agent.name}"${enabled !== undefined ? `, enabled=${enabled ? 1 : 0}` : ''};运行时将按新配置重载(下次任务生效)。`,
  }
}

export async function handleRemoveTeamAgent(args: Record<string, unknown>, ws: AgentWorkspace): Promise<HostToolResult> {
  const agentId = args.agent_id as string
  const reason = args.reason as string | undefined
  const result = await ws.removeTeamMember(agentId, reason)
  const recycleNote = result.recycledTasks.length > 0
    ? `其 ${result.recycledTasks.length} 个在途任务已回收(排队任务重派给剩余最短队列成员;执行中任务转 FAILED 待调度重试)。`
    : `该成员无在途任务。`
  return { text: `团队成员 ${agentId} 已移除。${recycleNote}` }
}
