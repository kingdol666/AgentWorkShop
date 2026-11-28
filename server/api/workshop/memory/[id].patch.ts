/** PATCH /api/workshop/memory/:id —— 人工覆写（原文快照进 memory_revisions）。 */
import { readBody, getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { MemoryAdminError, updateMemory } from '@/server/services/workshop/memory/memory-admin'
import { assertMemoryWritable, requireMemoryUser } from '@/server/services/workshop/memory/memory-access'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const { user, actor } = requireMemoryUser(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw new AppError(422, 'ID_REQUIRED', 'id 必填')
  assertMemoryWritable(user, id)
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  try {
    const res = await updateMemory(getAmlRuntime().db, {
      id,
      title: typeof body.title === 'string' ? body.title : undefined,
      content: typeof body.content === 'string' ? body.content : undefined,
      importance: typeof body.importance === 'number' ? body.importance : undefined,
      expectedRevision: Number(body.expectedRevision),
      reason: String(body.reason ?? ''),
      actor,
    })
    recordOps({
      actor: user.id, actorName: user.name, actorKind: 'user',
      action: 'memory.update', kind: 'system', targetKind: 'memory', targetId: id,
      summary: `人工覆写记忆 ${id.slice(0, 8)} → r${res.revision}（原文已留版本）`,
    })
    return res
  }
  catch (err) {
    if (err instanceof MemoryAdminError) throw new AppError(err.statusCode, err.code, err.message)
    throw err
  }
})
