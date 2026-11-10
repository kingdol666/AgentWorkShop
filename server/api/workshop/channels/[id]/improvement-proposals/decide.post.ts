/**
 * POST /api/workshop/channels/:id/improvement-proposals/decide —— 人工裁决提案。
 *
 * body: { proposalId, decision: 'accepted' | 'rejected' }
 * 权限：频道 owner/admin。只允许裁决 pending（终态不可改写）。
 *
 * 背景（2026-11-10 审计）：改进提案此前只有"自动收口"一条出口（且按配方 id
 * 全量收 accepted），人类无法驳回——`rejected` 状态实际上是死状态。
 */
import { getRouterParam, readValidatedBody } from 'h3'
import { z } from 'zod'
import { resolveUser } from '../../../caller'
import { defineApiHandler } from '../../../../../utils/response'
import { AppError } from '../../../../../utils/errors'
import { zValidator } from '../../../../../utils/validate'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { getAmlRuntime } from '../../../../../services/workshop/aml/runtime'
import { createImprovementRepo } from '../../../../../services/workshop/db/improvement.repo'

const schema = z.object({
  proposalId: z.string().trim().min(1, 'proposalId required'),
  decision: z.enum(['accepted', 'rejected'], { invalid_type_error: 'decision 只能是 accepted/rejected' }),
})

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const manager = getWorkshopManager()
  const ch = manager.getChannelForUser(channelId, user.id)
  manager.requireOwned(ch.ownerUserId, user.id, 'channel')
  const body = await readValidatedBody(event, zValidator(schema))
  const db = getAmlRuntime().db
  const repo = createImprovementRepo(db)
  const row = repo.get(body.proposalId)
  if (!row || row.channelId !== channelId) throw new AppError(404, 'NOT_FOUND', '提案不存在或不属于该频道')
  if (row.status !== 'pending') throw new AppError(409, 'ALREADY_DECIDED', `提案状态 ${row.status} 不能再次裁决`)
  repo.markStatus(body.proposalId, body.decision, user.id)
  return { proposal: repo.get(body.proposalId) }
})
