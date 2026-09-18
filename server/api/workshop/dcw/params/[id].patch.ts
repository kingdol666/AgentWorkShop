/**
 * PATCH /api/workshop/dcw/params/:id —— 编辑工艺参数映射(语义面/基准限界)。
 * nodeId 映射目标不可变(换绑请删建,避免账本悬空引用)。
 */
import { getRouterParam, readBody } from 'h3'
import type { DcwParamInput } from '#shared/dcw-protocol'
import { resolveUser } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { getDcwParamRepo } from '@/server/services/workshop/dcw/param-map.repo'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody<Partial<DcwParamInput>>(event) ?? {}
  // 产线权限:参数执行节点所在产线需「可操控」(限界是写控安全配置)
  requireLineMode(user, getDcwController().paramById(id).lineId, 'operate')
  const row = getDcwParamRepo().update(id, body)
  return { param: getDcwController().paramById(row.id) }
})
