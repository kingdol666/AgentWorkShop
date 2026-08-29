/**
 * POST /api/workshop/agent-tools/invoke —— 工具调用 HTTP 桥。
 * 与 omp host tools(daq_query / dcw_control / my_industrial_nodes)同一服务层:
 * 鉴权(节点绑定)→ 手动审批 → 安全联锁 → 物理语义结果。
 * body: { agentId, tool, args }
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { toolDaqQuery, toolDcwControl, toolMyIndustrialNodes } from '@/server/services/workshop/agents/industrial-tools'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const body = await readBody<{ agentId?: string, tool?: string, args?: Record<string, unknown> }>(event) ?? {}
  const agentId = String(body.agentId ?? '')
  const tool = String(body.tool ?? '')
  const args = body.args ?? {}
  if (!agentId) throw createError({ statusCode: 400, statusMessage: 'agentId required' })
  let result: { text: string, isError?: boolean }
  if (tool === 'my_industrial_nodes') result = await toolMyIndustrialNodes(agentId)
  else if (tool === 'dcw_control') result = await toolDcwControl(agentId, args as { node_id?: string, value?: number })
  else if (tool === 'daq_query') result = await toolDaqQuery(agentId, args as Parameters<typeof toolDaqQuery>[1])
  else throw createError({ statusCode: 400, statusMessage: `unknown tool: ${tool}` })
  return { result }
})
