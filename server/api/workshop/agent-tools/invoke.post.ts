/**
 * POST /api/workshop/agent-tools/invoke —— 工具调用 HTTP 桥。
 * 全量 host tool 分发(协作/任务/记忆/工业全族,与 omp set_host_tools 同源):
 * manager.invokeHostTool → impl.dispatchHostTool(共享 host-tool-bridge)。
 *
 * 鉴权(双通道):
 *  - 仪表盘用户:authorization Bearer(resolveUser);
 *  - agent 自证:x-aw-agent-token 头(channel_agents.token,stdio MCP 桥回程)。
 * body: { agentId, tool, args }
 */
import { readBody, getHeader } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

export default defineApiHandler(async (event) => {
  const agentToken = getHeader(event, 'x-aw-agent-token')
  if (!agentToken) resolveUser(event) // 桥路径免用户鉴权,由 token 校验兜底
  const body = await readBody<{ agentId?: string, tool?: string, args?: Record<string, unknown> }>(event) ?? {}
  const agentId = String(body.agentId ?? '')
  const tool = String(body.tool ?? '')
  const args = body.args ?? {}
  if (!agentId) throw createError({ statusCode: 400, statusMessage: 'agentId required' })
  if (!tool) throw createError({ statusCode: 400, statusMessage: 'tool required' })
  const result = await getWorkshopManager().invokeHostTool({ agentId, tool, args, token: agentToken || undefined })
  return { result }
})
