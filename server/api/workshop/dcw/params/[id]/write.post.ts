/**
 * POST /api/workshop/dcw/params/:id/write —— 工艺参数写入(用户/Agent 的标准写入口)。
 * body: { value: number }(工程量纲)。限界联锁(参数基准 ∩ 产品 ∩ 配方 ∩ 节点安全量程)
 * 在 DcwController.write 咽喉点统一生效,越界 400 并点名约束层。
 */
import { getRouterParam, readValidatedBody } from 'h3'
import { z } from 'zod'
import { resolveUser } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { zValidator } from '@/server/utils/validate'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

// 物理设备写面:value 必须是有限数值。**不用 coerce** —— z.coerce.number() 会把
// null/""/false/[] 一律折叠成 0 并放行(Number(null)===0 等),0 若落在量程内就是
// 一次真实的 0 设定下发。字符串数字由调用方自行转换(UI/MCP 均已发 number)。
const schema = z.object({
  value: z.number({ invalid_type_error: 'value 必须是数值(工程量纲)' })
    .finite('value 必须是有限数值'),
})

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  const { value } = await readValidatedBody(event, zValidator(schema))
  requireLineMode(user, getDcwController().paramById(id).lineId, 'operate')
  const outcome = await getDcwController().writeParam(id, value, { source: 'manual', actor: user.id, actorName: user.name })
  return { outcome }
})
