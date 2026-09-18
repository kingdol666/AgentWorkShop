/**
 * POST /api/workshop/dcw/params —— 创建工艺参数映射。
 * 路径一(nodeId):映射指向既有写控制执行节点;
 * 路径二(access):设备连接 + 寄存器 + 标准转换模式一键建映射
 *   (系统按转换模式自动创建执行节点,用户不手工拼装驱动配置)。
 */
import { readBody } from 'h3'
import type { DcwParamInput } from '#shared/dcw-protocol'
import { resolveUser } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const body = await readBody<Partial<DcwParamInput>>(event) ?? {}
  // 产线权限:目标产线(access 自动建节点)或执行节点所在产线需「可操控」
  const lineId = body.access
    ? (body.lineId ?? '')
    : (body.nodeId ? getDcwController().byId(String(body.nodeId))?.lineId : undefined)
  requireLineMode(user, lineId, 'operate')
  return { param: getDcwController().createParamMapping(body) }
})
