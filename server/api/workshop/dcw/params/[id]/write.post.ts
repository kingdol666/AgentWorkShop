/**
 * POST /api/workshop/dcw/params/:id/write —— 工艺参数写入(用户/Agent 的标准写入口)。
 * body: { value: number }(工程量纲)。限界联锁(参数基准 ∩ 产品 ∩ 配方 ∩ 节点安全量程)
 * 在 DcwController.write 咽喉点统一生效,越界 400 并点名约束层。
 */
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody<{ value?: number }>(event) ?? {}
  requireLineMode(user, getDcwController().paramById(id).lineId, 'operate')
  const outcome = await getDcwController().writeParam(id, Number(body.value), { source: 'manual', actor: user.id, actorName: user.name })
  return { outcome }
})
