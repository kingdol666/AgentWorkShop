/**
 * GET /api/workshop/approvals —— 高危操作复核记录列表(R3)。
 * admin/editor 可见全部;其他角色仅本人发起的记录(与 R1 审计查询同一可见性口径)。
 * ?scope=pending(默认,待审) | all(近 200 条含已裁决)
 */
import { getQuery } from 'h3'
import { resolveUser, isAdmin } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const repo = getOps()?.approvalRequests
  if (!repo) return { requests: [] }
  const q = getQuery(event)
  const scope = q.scope === 'all' ? 'all' : 'pending'
  const rows = scope === 'pending' ? repo.listPending() : repo.list(200)
  const visible = isAdmin(user) || user.role === 'editor'
    ? rows
    : rows.filter(r => r.requestedBy === user.id)
  return { requests: visible }
})
