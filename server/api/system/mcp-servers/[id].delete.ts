/**
 * DELETE /api/system/mcp-servers/[id] — 删除外部 MCP server（仅 admin）。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../utils/response'
import { requireRole } from '../../workshop/caller'
import { createMcpBroker } from '../../../services/workshop/mcp-client/broker'
import { recordOps } from '../../../services/workshop/ops/ops'
import { resolveRunMode } from '@/shared/config/home.mjs'

export default defineApiHandler((event) => {
  const user = requireRole(event, ['admin'])
  const id = getRouterParam(event, 'id') ?? ''
  createMcpBroker({ configRoot: resolveRunMode().configRoot }).remove(id)
  recordOps({
    actor: user.id,
    actorName: user.name,
    actorKind: 'user',
    action: 'system.mcp.remove',
    kind: 'system',
    targetKind: 'mcp_server',
    targetId: id,
    summary: `删除外部 MCP server ${id}`,
  })
  return { ok: true, id }
})
