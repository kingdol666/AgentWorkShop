/**
 * GET /api/workshop/exp/confirmations?lineId=&status= —— 推断动作待确认队列(产线 Co-Pilot)。
 * 登录用户;普通用户仅见授权产线(admin/editor 全量,与 dcw 列表可见性同口径)。
 * status 缺省 pending(confirmed/ignored 留档可查,传 all 返回全部)。
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { visibleLineIds } from '@/server/services/workshop/permissions'
import { defineApiHandler } from '@/server/utils/response'
import { getExpStateRepo } from '@/server/services/workshop/exp/exp-state.repo'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const q = getQuery(event)
  const lineId = String(q.lineId ?? '').trim() || undefined
  const statusQ = String(q.status ?? 'pending').trim().toLowerCase()
  const status = statusQ === 'all' || statusQ === ''
    ? undefined
    : (statusQ as 'pending' | 'confirmed' | 'ignored')
  const rows = getExpStateRepo().listConfirmations({ lineId, status })
  // 产线可见性:普通用户仅授权产线(readonly 即可看 —— 确认动作另有 operate 闸)
  const visible = visibleLineIds(user)
  const filtered = visible ? rows.filter(c => visible.has(c.lineId)) : rows
  return { confirmations: filtered }
})
