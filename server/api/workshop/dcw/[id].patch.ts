/**
 * PATCH /api/workshop/dcw/:id —— 单节点参数(名称/驱动/保写周期/量程/启停/落点)。
 *
 * 鉴权:与 write/test/bind 同口径 requireLineMode(..., 'operate')。
 * 本端点可改 driverConfig(落点 host:register)、min/max(直接决定 writeTolerance)、
 * holdIntervalMs(保写心跳周期)与 enabled —— 改完之后**网关自己的心跳**就会把
 * 该节点的既有设定值写进攻击者指定的目标。即「改参数」等价于「远程写 PLC」,
 * 早先此处只有 resolveUser,任何登录用户(零产线授权)都能改任意节点。
 */
import { createError, getRouterParam, readBody } from 'h3'
import type { DcwPatchInput } from '@/server/services/workshop/dcw/dcw-controller'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody<DcwPatchInput>(event) ?? {}
  const node0 = getDcwController().byId(id)
  if (!node0) throw createError({ statusCode: 404, statusMessage: `控制节点不存在: ${id}` })
  // 目标产线:允许本次 PATCH 迁移产线,则新产线也须有操控权(防止把节点搬到无权产线)
  const targetLine = body.lineId !== undefined ? String(body.lineId || '') || null : node0.lineId
  requireLineMode(user, targetLine, 'operate')
  const node = getDcwController().patch(id, body)
  return { node: node.toView() }
})
