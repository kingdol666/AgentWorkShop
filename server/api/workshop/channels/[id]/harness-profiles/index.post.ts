/**
 * POST /api/workshop/channels/:id/harness-profiles —— 新建 Harness Profile 版本（WP-B1）。
 *
 * body: { overlay?: string, pins?: string[], origin?: object, activate?: boolean }
 * 权限：channel owner/admin。缺省落 candidate；activate=true 直接激活（同频道旧 active 自动 supersede）。
 * 纪律：超限（overlay>800 字符 / pins>5）→ 400 拒绝，不静默截断。
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { zValidator } from '../../../../../utils/validate'
import { AppError, ErrorCodes } from '../../../../../utils/errors'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { resolveUser } from '../../../caller'
import { getAmlRuntime } from '../../../../../services/workshop/aml/runtime'
import { OVERLAY_MAX_CHARS, PINS_MAX, createHarnessProfileRepo } from '../../../../../services/workshop/experience/harness-profile'

const schema = z.object({
  overlay: z.string().max(OVERLAY_MAX_CHARS, `overlay 上限 ${OVERLAY_MAX_CHARS} 字符`).optional(),
  pins: z.array(z.string().min(1)).max(PINS_MAX, `pins 上限 ${PINS_MAX} 条`).optional(),
  origin: z.record(z.string(), z.unknown()).optional(),
  activate: z.boolean().optional(),
})

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const manager = getWorkshopManager()
  const ch = manager.getChannelForUser(channelId, user.id)
  manager.requireOwned(ch.ownerUserId, user.id, 'channel')
  const body = await readValidatedBody(event, zValidator(schema))
  const repo = createHarnessProfileRepo(getAmlRuntime().db)
  try {
    const created = repo.create({
      channelId,
      layers: { overlay: body.overlay ?? '', pins: body.pins ?? [] },
      origin: { source: 'rest', ...(body.origin ?? {}) },
      createdBy: user.id,
      status: body.activate ? 'active' : 'candidate',
    })
    return { profile: created }
  }
  catch (err) {
    throw new AppError(400, ErrorCodes.BAD_REQUEST, err instanceof Error ? err.message : String(err))
  }
})
