/**
 * POST /api/workshop/daq —— 创建数采节点(server 权威实体;拖入场景/加通道入口)。
 * body: { templateRef?, name?, driver?, unit?, decimals?, min?, max?, warnLow?, warnHigh?,
 *         intervalMs?, enabled?, posX?, posZ?, deviceBindingId? }
 * 创建后广播 daq.node.changed(added),全部已连客户端即时收敛。
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDaqHost } from '@/server/services/workshop/daq/host-bindings'
import { getDaqController, type DaqCreateInput } from '@/server/services/workshop/daq/daq-controller'
import { broadcastSceneEvent } from '../../../services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  bindDaqHost(broadcastSceneEvent)
  const body = await readBody<DaqCreateInput>(event) ?? {}
  const node = getDaqController().create(body)
  return { node: node.toView() }
})
