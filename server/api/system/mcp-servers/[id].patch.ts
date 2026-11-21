/**
 * PATCH /api/system/mcp-servers/[id] — 修改 endpoint/凭据引用/启用/数据域（仅 admin）。
 * endpoint 或 credentialRef 变化会自增 generation 并把工具置回 pending。
 */
import { getRouterParam, readBody } from 'h3'
import { defineApiHandler } from '../../../utils/response'
import { requireRole } from '../../workshop/caller'
import { AppError } from '../../../utils/errors'
import { createMcpBroker } from '../../../services/workshop/mcp-client/broker'
import { recordOps } from '../../../services/workshop/ops/ops'
import { resolveRunMode } from '@/shared/config/home.mjs'

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin'])
  const id = getRouterParam(event, 'id') ?? ''
  const body = (await readBody<Record<string, unknown>>(event)) ?? {}
  if (body.dataSharing !== undefined && body.dataSharing !== 'shared-safe' && body.dataSharing !== 'project-private' && body.dataSharing !== 'unknown') {
    throw new AppError(400, 'VALIDATION_ERROR', 'dataSharing 非法')
  }
  const broker = createMcpBroker({ configRoot: resolveRunMode().configRoot })
  const server = broker.patch(id, {
    label: typeof body.label === 'string' ? body.label : undefined,
    endpoint: typeof body.endpoint === 'string' ? body.endpoint : undefined,
    credentialRef: body.credentialRef === null ? null : typeof body.credentialRef === 'string' ? body.credentialRef : undefined,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    dataSharing: body.dataSharing,
    maxDiscoveryAgeMs: typeof body.maxDiscoveryAgeMs === 'number' ? body.maxDiscoveryAgeMs : undefined,
  })
  recordOps({
    actor: user.id,
    actorName: user.name,
    actorKind: 'user',
    action: 'system.mcp.patch',
    kind: 'system',
    targetKind: 'mcp_server',
    targetId: server.id,
    summary: `更新外部 MCP server ${server.id}${server.tools.some(t => t.reviewStatus === 'pending') ? '（工具已回到 pending 审阅）' : ''}`,
  })
  return server
})
