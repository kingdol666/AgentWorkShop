/** DELETE /api/workshop/memory/:id —— 软删（30 天内可恢复；硬删走 /purge）。 */
import { getQuery, getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { MemoryAdminError, softDeleteMemory } from '@/server/services/workshop/memory/memory-admin'
import { assertMemoryWritable, requireMemoryUser } from '@/server/services/workshop/memory/memory-access'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const { user, actor } = requireMemoryUser(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw new AppError(422, 'ID_REQUIRED', 'id 必填')
  assertMemoryWritable(user, id)
  const q = getQuery(event)
  const reason = typeof q.reason === 'string' ? q.reason : '人工软删'
  try {
    const res = softDeleteMemory(getAmlRuntime().db, { id, reason, actor })
    if (res.ok) {
      recordOps({
        actor: user.id, actorName: user.name, actorKind: 'agent',
        action: 'memory.soft_delete', kind: 'system', targetKind: 'memory', targetId: id,
        summary: `软删记忆 ${id.slice(0, 8)}：${reason}`,
      })
    }
    return res
  }
  catch (err) {
    if (err instanceof MemoryAdminError) throw new AppError(err.statusCode, err.code, err.message)
    throw err
  }
})
