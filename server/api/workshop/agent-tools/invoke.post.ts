/**
 * POST /api/workshop/agent-tools/invoke —— 工具调用 HTTP 桥。
 * 与 omp host tools(工业工具族)同一服务层:鉴权(节点绑定)→ 手动审批 → 安全联锁 → 物理语义结果。
 * body: { agentId, tool, args }
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'
import {
  toolDaqQuery,
  toolDcwControl,
  toolDcwJournal,
  toolDcwJudge,
  toolDcwRollback,
  toolMyIndustrialNodes,
} from '@/server/services/workshop/agents/industrial-tools'

/** 协作工具族:经 manager 工具桥落到 agent workspace(跨团队可见性/跨 Channel 通信) */
const COLLAB_TOOLS = new Set(['list_other_teams', 'search_other_teams_memory', 'send_cross_channel_message'])

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const body = await readBody<{ agentId?: string, tool?: string, args?: Record<string, unknown> }>(event) ?? {}
  const agentId = String(body.agentId ?? '')
  const tool = String(body.tool ?? '')
  const args = body.args ?? {}
  if (!agentId) throw createError({ statusCode: 400, statusMessage: 'agentId required' })
  let result: { text: string, isError?: boolean }
  if (COLLAB_TOOLS.has(tool)) {
    result = getWorkshopManager().invokeAgentWorkspaceTool(agentId, tool, args)
  }
  else if (tool === 'my_industrial_nodes') result = await toolMyIndustrialNodes(agentId)
  else if (tool === 'dcw_control') result = await toolDcwControl(agentId, args as { node_id?: string, value?: number, hypothesis?: string, task_id?: string })
  else if (tool === 'daq_query') result = await toolDaqQuery(agentId, args as Parameters<typeof toolDaqQuery>[1])
  else if (tool === 'dcw_judge') result = await toolDcwJudge(agentId, args as { record_id?: string, verdict?: string, reason?: string })
  else if (tool === 'dcw_rollback') result = await toolDcwRollback(agentId, args as { record_id?: string, node_id?: string, to?: string })
  else if (tool === 'dcw_journal') result = await toolDcwJournal(agentId, args as { node_id?: string, recipe_id?: string, limit?: number | string })
  else throw createError({ statusCode: 400, statusMessage: `unknown tool: ${tool}` })
  return { result }
})
