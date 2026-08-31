/**
 * GET /api/workshop/daq —— 数采节点列表 + 控制器状态 + 后端能力自描述(登录用户)。
 * 首访触发存量 device-twins(kind=daq)的幂等升格供给,此后渲染完全由本列表驱动。
 */
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDaqHost } from '@/server/services/workshop/daq/host-bindings'
import { getDaqController } from '@/server/services/workshop/daq/daq-controller'
import { listDaqTemplates } from '@/server/services/workshop/daq/daq-templates'
import { tsdbReady } from '@/server/services/workshop/daq/storage'
import { getDaqQueue } from '@/server/services/workshop/daq/bus'
import { daqInfraStatus } from '@/server/services/workshop/daq/infra'
import { broadcastSceneEvent } from '../../../services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  // ws.ts 出口装配 + 管线上电(幂等;路由模块加载即绑定)
  bindDaqHost(broadcastSceneEvent)
  await Promise.all([tsdbReady, getDaqQueue()])
  const ctrl = getDaqController()
  ctrl.provisionLegacyTwins()
  const state = ctrl.controllerState()
  return {
    controller: state,
    nodes: ctrl.listViews(),
    meta: {
      ...ctrl.backends(),
      produced: state.produced ?? 0,
      consumed: state.consumed ?? 0,
      dropped: state.dropped ?? 0,
      samplesStored: state.samplesStored ?? 0,
    },
    // 驱动协议栈可用性(包缺失 → UI 显示"未安装")
    driverAvailable: await ctrl.driverAvailability(),
    // 基础设施在线状态(降级 → 前端横幅 + 重连入口)
    infra: daqInfraStatus(),
    // 信号模板目录(内置 + 用户自定义;前端下拉/左轨/控制台同源消费)
    templates: listDaqTemplates(),
  }
})
