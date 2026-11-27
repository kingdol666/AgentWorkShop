/** GET /api/workshop/memory/:id/revisions —— 版本链（覆写前原文）。 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { createMemoryRepo } from '@/server/services/workshop/db/memory.repo'
import { assertMemoryWritable, requireMemoryUser } from '@/server/services/workshop/memory/memory-access'

export default defineApiHandler(async (event) => {
  const { user } = requireMemoryUser(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw new AppError(422, 'ID_REQUIRED', 'id 必填')
  assertMemoryWritable(user, id)
  // 读口径与 GET /memory/:id 对齐（2026-11-28 审核轮）：版本链含历史正文，
  // 非 admin 还必须行 owner 本人 —— 否则频道 owner 能读到"正文读不到"的历史正文。
  if (user.role !== 'admin') {
    const row = getAmlRuntime().db.prepare('SELECT owner_user_id AS owner FROM agent_memories WHERE id = ?')
      .get(id) as { owner?: string | null } | undefined
    if (!row) throw new AppError(404, 'NOT_FOUND', '记忆不存在')
    if ((row.owner ?? null) !== user.id) throw new AppError(403, 'FORBIDDEN', '无权查看该记忆的版本链')
  }
  return { revisions: createMemoryRepo(getAmlRuntime().db).listRevisions(id) }
})
