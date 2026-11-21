/**
 * POST /api/system/mcp-servers — 登记外部 MCP server（仅 admin；默认停用，需显式发现/审阅）。
 */
import { readBody } from 'h3'
import { defineApiHandler } from '../../../utils/response'
import { requireRole } from '../../workshop/caller'
import { AppError } from '../../../utils/errors'
import { createMcpBroker } from '../../../services/workshop/mcp-client/broker'
import { recordOps } from '../../../services/workshop/ops/ops'
import { resolveRunMode } from '@/shared/config/home.mjs'

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin'])
  const body = (await readBody<Record<string, unknown>>(event)) ?? {}
  const id = typeof body.id === 'string' ? body.id : ''
  const label = typeof body.label === 'string' ? body.label : ''
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : ''
  if (!id || !label || !endpoint) throw new AppError(400, 'VALIDATION_ERROR', 'id/label/endpoint 必填')
  const broker = createMcpBroker({ configRoot: resolveRunMode().configRoot })
  const server = broker.create({
    id,
    label,
    endpoint,
    credentialRef: typeof body.credentialRef === 'string' ? body.credentialRef : undefined,
    dataSharing: body.dataSharing ?? 'unknown',
    maxDiscoveryAgeMs: typeof body.maxDiscoveryAgeMs === 'number' ? body.maxDiscoveryAgeMs : undefined,
  })
  recordOps({
    actor: user.id,
    actorName: user.name,
    actorKind: 'user',
    action: 'system.mcp.create',
    kind: 'system',
    targetKind: 'mcp_server',
    targetId: server.id,
    summary: `登记外部 MCP server ${server.id}（${server.dataSharing}）`,
  })
  return server
})
