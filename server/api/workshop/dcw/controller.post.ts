/**
 * POST /api/workshop/dcw/controller —— 网关总控:{ action: 'start' | 'stop' }。
 * R3:admin/editor 才可执行;approvalGate 开启时走双人复核(同 apply 口径)。
 */
import { readBody, setResponseStatus } from 'h3'
import { requireRole } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { gateDangerous } from '@/server/utils/approval-gate'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'
import { audit } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = requireRole(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const ctrl = getDcwController()
  const body = await readBody<{ action?: 'start' | 'stop' }>(event) ?? {}
  const action = body.action === 'stop' ? 'stop' : 'start'
  const gate = gateDangerous(useRuntimeConfig(event).approvalGate === true, user, { action: 'dcw.controller', targetId: `gateway:${action}`, summary: `写控制网关${action === 'stop' ? '停止' : '启动'}全部节点` }, (body as { approvalId?: string }).approvalId)
  if (gate.pending) {
    setResponseStatus(event, 202)
    return { pending: true, requestId: gate.requestId }
  }
  const controller = action === 'stop' ? ctrl.stopAll() : ctrl.startAll()
  // R1:网关总控(影响全部下游设备)留痕
  audit({ actor: user.id, actorName: user.name, actorKind: 'user', action: `dcw.controller.${action}`, targetKind: 'dcw-gateway', targetId: 'gateway' })
  return { controller }
})
