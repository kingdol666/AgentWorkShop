/**
 * POST /api/workshop/channels/:id/harness-profiles/promote —— Profile 晋升/回滚（WP-B3/B4）。
 *
 * body: { profileId, to: 'shadow' } | { profileId, to: 'active', benchRunId } | { rollback: true }
 * 权限：channel owner/admin（人审批；Agent 工具面不可达）。
 * 纪律：shadow→active **必须**引用已落库的 benchRunId（POST .../harness-bench-runs）——
 *       旧接口直接收 body.bench 三个数字，与任何一次运行都没有绑定（2026-11-10 审计）。
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { zValidator } from '../../../../../utils/validate'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { resolveUser } from '../../../caller'
import { getAmlRuntime } from '../../../../../services/workshop/aml/runtime'
import { promoteProfile, rollbackProfile } from '../../../../../services/workshop/experience/promote'

const schema = z.object({
  profileId: z.string().min(1).optional(),
  to: z.enum(['shadow', 'active']).optional(),
  rollback: z.boolean().optional(),
  /** 配对评测台账 id（promote→active 必填） */
  benchRunId: z.string().trim().min(1).optional(),
  /** @deprecated 仅 shadow 阶段兼容;active 不再接受自报数字 */
  bench: z.object({
    pValue: z.number().nullable(),
    primaryDelta: z.number(),
    costDelta: z.number(),
  }).optional(),
})

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const manager = getWorkshopManager()
  const ch = manager.getChannelForUser(channelId, user.id)
  manager.requireOwned(ch.ownerUserId, user.id, 'channel')
  const body = await readValidatedBody(event, zValidator(schema))
  const db = getAmlRuntime().db
  if (body.rollback) {
    const res = rollbackProfile(db, { channelId, actor: user.id })
    return res
  }
  if (!body.profileId || !body.to) return { ok: false, reasons: ['profileId 与 to 必填（或 rollback=true）'] }
  return promoteProfile(db, {
    profileId: body.profileId,
    channelId,
    to: body.to,
    actor: user.id,
    benchRunId: body.benchRunId,
    bench: body.bench ?? null,
  })
})
