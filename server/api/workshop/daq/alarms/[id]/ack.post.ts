/**
 * POST /api/workshop/daq/alarms/:id/ack —— 报警确认(S5 ack 闭环)。
 * body 可空;记录 acked_by/acked_at(裁决人留痕,同 S4 口径)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { defineApiHandler } from '@/server/utils/response'
import { getDaqController } from '@/server/services/workshop/daq/daq-controller'
import { getOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id')!
  // 产线权限:告警确认属操控动作(需对该线「可操控」;readonly/无权 403)
  const alarmNodeId = getOps()?.alarmEvents.nodeIdById(id)
  requireLineMode(user, alarmNodeId ? getDaqController().byId(alarmNodeId)?.lineId : undefined, 'operate')
  const acked = getDaqController().ackAlarm(id, user.id, user.name)
  return { acked, id }
})
