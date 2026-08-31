/**
 * POST /api/workshop/daq/alarms/:id/ack —— 报警确认(S5 ack 闭环)。
 * body 可空;记录 acked_by/acked_at(裁决人留痕,同 S4 口径)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getDaqController } from '@/server/services/workshop/daq/daq-controller'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id')!
  const acked = getDaqController().ackAlarm(id, user.id, user.name)
  return { acked, id }
})
