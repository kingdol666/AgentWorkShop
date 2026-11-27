/** POST /api/workshop/memory/:id/unprotect —— 解除人工保护（交还自动维护；旧版先快照）。 */
import { readBody, getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { MemoryAdminError, unprotectMemory } from '@/server/services/workshop/memory/memory-admin'
import { assertMemoryWritable, requireMemoryUser } from '@/server/services/workshop/memory/memory-access'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const { user, actor } = requireMemoryUser(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw new AppError(422, 'ID_REQUIRED', 'id 必填')
  assertMemoryWritable(user, id)
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  try {
    const res = unprotectMemory(getAmlRuntime().db, {
      id,
      expectedRevision: Number(body.expectedRevision),
      reason: String(body.reason ?? ''),
      actor,
    })
    recordOps({
      actor: user.id, actorName: user.name, actorKind: 'user',
      action: 'memory.unprotect', kind: 'system', targetKind: 'memory', targetId: id,
      summary: `解除人工保护 ${id.slice(0, 8)}（交还自动维护）→ r${res.revision}`,
    })
    return res
  }
  catch (err) {
    if (err instanceof MemoryAdminError) throw new AppError(err.statusCode, err.code, err.message)
    throw err
  }
})
