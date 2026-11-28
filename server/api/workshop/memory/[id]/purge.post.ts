/** POST /api/workshop/memory/:id/purge —— 硬删（仅 owner/admin；须先软删）。 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { MemoryAdminError, purgeMemory } from '@/server/services/workshop/memory/memory-admin'
import { assertMemoryWritable, requireMemoryUser } from '@/server/services/workshop/memory/memory-access'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const { user } = requireMemoryUser(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw new AppError(422, 'ID_REQUIRED', 'id 必填')
  assertMemoryWritable(user, id)
  try {
    const res = purgeMemory(getAmlRuntime().db, id)
    if (res.ok) {
      recordOps({
        actor: user.id, actorName: user.name, actorKind: 'user',
        action: 'memory.purge', kind: 'system', targetKind: 'memory', targetId: id,
        summary: `硬删记忆 ${id.slice(0, 8)}（FTS/向量已清理）`,
      })
    }
    return res
  }
  catch (err) {
    if (err instanceof MemoryAdminError) throw new AppError(err.statusCode, err.code, err.message)
    throw err
  }
})
