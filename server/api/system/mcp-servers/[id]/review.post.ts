/**
 * POST /api/system/mcp-servers/[id]/review — 审阅单个工具（仅 admin）。
 * 批准条件：dataSharing=shared-safe 且 classification=read。
 */
import { getRouterParam, readBody } from 'h3'
import { defineApiHandler } from '../../../../utils/response'
import { requireRole } from '../../../workshop/caller'
import { AppError } from '../../../../utils/errors'
import { createMcpBroker } from '../../../../services/workshop/mcp-client/broker'
import { recordOps } from '../../../../services/workshop/ops/ops'
import { resolveRunMode } from '@/shared/config/home.mjs'

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin'])
  const id = getRouterParam(event, 'id') ?? ''
  const body = (await readBody<Record<string, unknown>>(event)) ?? {}
  const toolId = typeof body.toolId === 'string' ? body.toolId : ''
  const status = body.status === 'approved' || body.status === 'rejected' ? body.status : null
  if (!toolId || !status) throw new AppError(400, 'VALIDATION_ERROR', 'toolId/status 必填')
  if (body.classification !== undefined && body.classification !== 'read' && body.classification !== 'write') {
    throw new AppError(400, 'VALIDATION_ERROR', 'classification 必须是 read/write')
  }
  const result = createMcpBroker({ configRoot: resolveRunMode().configRoot }).review(id, toolId, {
    status,
    classification: body.classification as 'read' | 'write' | undefined,
  }, user.id)
  recordOps({
    actor: user.id,
    actorName: user.name,
    actorKind: 'user',
    action: 'system.mcp.review',
    kind: 'system',
    targetKind: 'mcp_tool',
    targetId: result.tool.id,
    summary: `${status === 'approved' ? '批准' : '拒绝'} MCP 工具 ${result.tool.exposedName}`,
  })
  return result
})
