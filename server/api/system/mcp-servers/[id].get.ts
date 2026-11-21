/**
 * GET /api/system/mcp-servers/[id] — 单个受管 MCP server（admin/editor）。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../utils/response'
import { requireRole } from '../../workshop/caller'
import { createMcpBroker } from '../../../services/workshop/mcp-client/broker'
import { resolveRunMode } from '@/shared/config/home.mjs'

export default defineApiHandler((event) => {
  requireRole(event, ['admin', 'editor'])
  const id = getRouterParam(event, 'id') ?? ''
  return createMcpBroker({ configRoot: resolveRunMode().configRoot }).get(id)
})
