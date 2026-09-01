/**
 * POST /api/workshop/daq/controller —— 采集总控:
 * { action: 'start'|'stop'|'pause'|'resume'|'config', defaultIntervalMs?, defaultPublishIntervalMs? }
 *
 * pause/resume 为快照语义:暂停记录「当前启用节点集」,恢复仅恢复该集合
 * (暂停期间手动停用的节点不被波及)。start/stop 为无快照的全局启停。
 */
import { readBody } from 'h3'
import { requireRole, resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDaqHost } from '@/server/services/workshop/daq/host-bindings'
import { getDaqController } from '@/server/services/workshop/daq/daq-controller'
import { broadcastSceneEvent } from '../../../services/workshop/scene-events'
import { recordOps } from '@/server/services/workshop/ops/ops'

const GATEWAY_ZH = { start: '启动', stop: '停止', pause: '暂停', resume: '恢复' } as const

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDaqHost(broadcastSceneEvent)
  const ctrl = getDaqController()
  const body = await readBody<{ action?: 'start' | 'stop' | 'pause' | 'resume' | 'config', defaultIntervalMs?: number, defaultPublishIntervalMs?: number }>(event) ?? {}
  switch (body.action) {
    case 'pause':
    case 'resume':
    case 'start':
    case 'stop': {
      // 总控属控制面操作:admin/editor 才可执行;pause/resume 快照留痕
      requireRole(event, ['admin', 'editor'])
      const controller = body.action === 'pause'
        ? ctrl.pauseAll()
        : body.action === 'resume'
          ? ctrl.resumeAll()
          : body.action === 'stop' ? ctrl.stopAll() : ctrl.startAll()
      recordOps({
        actor: user.id,
        actorName: user.name,
        actorKind: 'user',
        action: `daq.controller.${body.action}`,
        kind: 'daq',
        targetKind: 'daq-gateway',
        targetId: 'gateway',
        summary: `数采网关${GATEWAY_ZH[body.action]}全部采集`,
      })
      return { controller }
    }
    case 'config':
      return { controller: ctrl.configure({ defaultIntervalMs: body.defaultIntervalMs, defaultPublishIntervalMs: body.defaultPublishIntervalMs }) }
    default:
      return { controller: ctrl.controllerState() }
  }
})
