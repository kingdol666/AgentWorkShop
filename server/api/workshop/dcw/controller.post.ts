/**
 * POST /api/workshop/dcw/controller —— 网关总控:{ action: 'start' | 'stop' | 'pause' | 'resume' }。
 * R3:admin/editor 才可执行;approvalGate 开启时走双人复核(同 apply 口径)。
 * pause/resume 为快照语义:暂停记录「当前启用节点集」,恢复仅恢复该集合。
 */
import { readBody, setResponseStatus } from 'h3'
import { requireRole } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { gateDangerous } from '@/server/utils/approval-gate'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = requireRole(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const ctrl = getDcwController()
  const body = await readBody<{ action?: 'start' | 'stop' | 'pause' | 'resume' }>(event) ?? {}
  const action = (body.action === 'stop' || body.action === 'pause' || body.action === 'resume') ? body.action : 'start'
  const zh = { start: '启动', stop: '停止', pause: '暂停', resume: '恢复' } as const
  const gate = gateDangerous(useRuntimeConfig(event).approvalGate === true, user, { action: 'dcw.controller', targetId: `gateway:${action}`, summary: `写控制网关${zh[action]}全部节点` }, (body as { approvalId?: string }).approvalId)
  if (gate.pending) {
    setResponseStatus(event, 202)
    return { pending: true, requestId: gate.requestId }
  }
  const controller = action === 'stop'
    ? ctrl.stopAll()
    : action === 'pause'
      ? ctrl.pauseAll()
      : action === 'resume' ? ctrl.resumeAll() : ctrl.startAll()
  // R1:网关总控(影响全部下游设备)留痕 + 实时事件
  recordOps({
    actor: user.id,
    actorName: user.name,
    actorKind: 'user',
    action: `dcw.controller.${action}`,
    kind: 'system',
    targetKind: 'dcw-gateway',
    targetId: 'gateway',
    summary: `写控制网关${zh[action]}全部节点`,
  })
  return { controller }
})
