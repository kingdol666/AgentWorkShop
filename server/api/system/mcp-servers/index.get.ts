/**
 * GET /api/system/mcp-servers — 受管外部 MCP 清单（admin/editor 只读，凭据只显示引用名）。
 */
import { defineApiHandler } from '../../../utils/response'
import { requireRole } from '../../workshop/caller'
import { createMcpBroker } from '../../../services/workshop/mcp-client/broker'
import { resolveRunMode } from '@/shared/config/home.mjs'

export default defineApiHandler((event) => {
  requireRole(event, ['admin', 'editor'])
  const broker = createMcpBroker({ configRoot: resolveRunMode().configRoot })
  return { servers: broker.list() }
})
