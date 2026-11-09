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

// 物理设备写面:value 必须是有限数值。coerce 保留既有宽松输入(前端表单字符串 "12.5"),
// 但拒绝 NaN/Infinity/对象/数组 —— 这些过去会带着 NaN 抵达控制器,violating 契约前移到入口。
const schema = z.object({
  value: z.coerce.number({ invalid_type_error: 'value 必须是数值(工程量纲)' })
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
