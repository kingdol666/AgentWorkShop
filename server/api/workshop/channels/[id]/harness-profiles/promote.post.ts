/**
 * POST /api/workshop/channels/:id/harness-profiles/promote —— Profile 晋升/回滚（WP-B3/B4）。
 *
 * body: { profileId?: string, to?: 'shadow'|'active', bench?: PairedBenchResult } | { rollback: true }
 * 权限：channel owner/admin（人审批；Agent 工具面不可达）。
 * 纪律：shadow→active 必须带配对结果（WP-B2）；无结果 → 409 附理由。
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
    bench: body.bench ?? null,
  })
})
