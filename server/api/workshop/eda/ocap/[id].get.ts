/**
 * GET   /api/workshop/eda/ocap/:id —— 处置单详情(弱关联存在性校验随行)。
 * PATCH /api/workshop/eda/ocap/:id —— 追加步骤 {step} / 关单 {status:'closed'|'void', linked_exploration_id?, linked_rollback_anchor?}。
 */
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { ocapById, addOcapStep, closeOcap } from '@/server/services/workshop/eda/ocap'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  if (event.method === 'GET') {
    const row = ocapById(user, id)
    if (!row) throw new AppError(404, 'NOT_FOUND' as never, `OCAP 不存在或不可见: ${id}`)
    return { record: row }
  }
  const body = await readBody<{ step?: string, status?: string, linked_exploration_id?: string, linked_rollback_anchor?: string }>(event) ?? {}
  try {
    if (body.step != null) {
      return { record: await addOcapStep(user, id, String(body.step)) }
    }
    const status = String(body.status ?? '') as 'closed' | 'void'
    if (status !== 'closed' && status !== 'void') {
      throw new AppError(400, 'VALIDATION_ERROR' as never, 'status 只支持 \'closed\' | \'void\'(追加处置步骤请传 {step})。')
    }
    return { record: closeOcap(user, id, {
      status,
      linkedExplorationId: body.linked_exploration_id ? String(body.linked_exploration_id) : undefined,
      linkedRollbackAnchor: body.linked_rollback_anchor ? String(body.linked_rollback_anchor) : undefined,
    }) }
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = /不存在或不可见/.test(msg) ? 404 : /仅 owner/.test(msg) ? 403 : 400
    throw new AppError(status, 'VALIDATION_ERROR' as never, msg)
  }
})
