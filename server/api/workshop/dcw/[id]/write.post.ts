/**
 * POST /api/workshop/dcw/:id/write —— 设定值下发(核心写命令;body: { value: number })。
 * 工程量安全校验 → 驱动换算/写/回读校验 → ACK。越界 400;在飞 409。
 */
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody<{ value?: number }>(event) ?? {}
  const outcome = await getDcwController().write(id, Number(body.value))
  return { outcome }
})
