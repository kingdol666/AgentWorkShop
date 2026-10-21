/**
 * PATCH /api/workshop/eda/ocap/:id —— 追加处置步骤 {step} / 关单 {status:'closed'|'void', ...}。
 */
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { addOcapStep, closeOcap } from '@/server/services/workshop/eda/ocap'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody<{ step?: string, status?: string, linked_exploration_id?: string, linked_rollback_anchor?: string }>(event) ?? {}
  try {
    if (body.step != null) {
      return { record: addOcapStep(user, id, String(body.step)) }
    }
    const status = String(body.status ?? '') as 'closed' | 'void'
    if (status !== 'closed' && status !== 'void') {
      throw new Error('status 只支持 \'closed\' | \'void\'(追加处置步骤请传 {step})。')
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
