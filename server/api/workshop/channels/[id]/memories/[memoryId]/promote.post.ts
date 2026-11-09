/**
 * POST /api/workshop/channels/:id/memories/:memoryId/promote —— 经验条目晋升/退休（WP-B3）。
 *
 * body: { to: 'validated' | 'retired' }
 * 权限：channel owner/admin（人在审批；Agent 工具面不可达）。
 * 门判定失败 → 200 { ok:false, reasons }（附差多少，便于补齐证据后重试）。
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { zValidator } from '../../../../../../utils/validate'
import { defineApiHandler } from '../../../../../../utils/response'
import { getWorkshopManager } from '../../../../../../plugins/workshop'
import { resolveUser } from '../../../../caller'
import { getAmlRuntime } from '../../../../../../services/workshop/aml/runtime'
import { promoteExperience } from '../../../../../../services/workshop/experience/promote'

const schema = z.object({ to: z.enum(['validated', 'retired']) })

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const memoryId = getRouterParam(event, 'memoryId')!
  const user = resolveUser(event)
  const manager = getWorkshopManager()
  const ch = manager.getChannelForUser(channelId, user.id)
  manager.requireOwned(ch.ownerUserId, user.id, 'channel')
  const body = await readValidatedBody(event, zValidator(schema))
  return promoteExperience(getAmlRuntime().db, {
    memoryId,
    channelId,
    to: body.to,
    actor: user.id,
  })
})
