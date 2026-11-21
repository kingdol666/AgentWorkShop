/**
 * POST /api/system/mcp-servers/[id]/discover — 连接并发现工具（仅 admin）。
 * 结果全部 pending；不能在这里批准。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../utils/response'
import { requireRole } from '../../../workshop/caller'
import { createMcpBroker } from '../../../../services/workshop/mcp-client/broker'
import { recordOps } from '../../../../services/workshop/ops/ops'
import { resolveRunMode } from '@/shared/config/home.mjs'

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin'])
  const id = getRouterParam(event, 'id') ?? ''
  const server = await createMcpBroker({ configRoot: resolveRunMode().configRoot }).discover(id)
  recordOps({
    actor: user.id,
    actorName: user.name,
    actorKind: 'user',
    action: 'system.mcp.discover',
    kind: 'system',
    targetKind: 'mcp_server',
    targetId: id,
    summary: `发现外部 MCP server ${id}：${server.tools.length} 个工具待审阅`,
  })
  return server
})
