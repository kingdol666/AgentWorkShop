/**
 * POST /api/workshop/daq —— 创建数采节点(server 权威实体;拖入场景/加通道入口)。
 * body: { templateRef?, name?, driver?, unit?, decimals?, min?, max?, warnLow?, warnHigh?,
 *         intervalMs?, enabled?, posX?, posZ?, deviceBindingId?, fields?, fieldsBase? }
 * 创建后广播 daq.node.changed(added),全部已连客户端即时收敛。
 *
 * 多字段展开:MQTT 单 topic 多字段可用 fields(或 driverConfig.fields)一次声明,
 * 平台展开为多个 scalar 子节点(独立量程/告警,共享一次订阅),响应返回 nodes+groupId。
 */
import { readBody } from 'h3'
import { requireRole } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDaqHost } from '@/server/services/workshop/daq/host-bindings'
import { getDaqController, type DaqCreateInput } from '@/server/services/workshop/daq/daq-controller'
import { buildMqttFieldGroup, hasMqttFieldSpecs } from '@/server/services/workshop/daq/field-group'
import { broadcastSceneEvent } from '../../../services/workshop/scene-events'
import { recordOps } from '../../../services/workshop/ops/ops'
import { getDcwLineRepo } from '../../../services/workshop/dcw/dcw-line.repo'
import { AppError, ErrorCodes } from '../../../utils/errors'

export default defineApiHandler(async (event) => {
  const user = requireRole(event)
  bindDaqHost(broadcastSceneEvent)
  const body = await readBody<DaqCreateInput>(event) ?? {}
  if (body.lineId && !getDcwLineRepo().byId(body.lineId)) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `产线不存在: ${body.lineId}`)
  }
  const driverConfig = (body.driverConfig ?? {}) as Record<string, unknown>
  if (hasMqttFieldSpecs(driverConfig, body.fields)) {
    // 一次配置 → N 个子信号节点:先全量校验并构建,再逐个落地;任一失败回滚已建节点
    const plan = buildMqttFieldGroup(body)
    if (!plan) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'fields 声明为空:至少配置一个字段')
    const created = []
    try {
      for (const input of plan.inputs) created.push(getDaqController().create(input))
    }
    catch (err) {
      for (const n of created) {
        try {
          getDaqController().remove(n.id)
        }
        catch { /* 回滚尽力而为:失败项由后续巡检/人工清理 */ }
      }
      throw err instanceof AppError
        ? err
        : new AppError(400, ErrorCodes.VALIDATION_ERROR, `多字段节点创建失败(已回滚 ${created.length} 个):${err instanceof Error ? err.message : String(err)}`)
    }
    recordOps({
      actor: user.id,
      actorName: user.name,
      actorKind: 'user',
      action: 'daq.node.create',
      kind: 'daq',
      targetKind: 'daq-node',
      targetId: plan.groupId,
      summary: `创建 MQTT 多字段组「${plan.baseName}」(${created.length} 个字段节点)`,
      lineId: created[0]?.lineId ?? '',
      detail: { groupId: plan.groupId, fields: plan.inputs.map(i => i.name), driver: 'mqtt' },
    })
    return {
      nodes: created.map(n => n.toView()),
      groupId: plan.groupId,
      count: created.length,
      // 兼容旧调用方:单节点语义取第一个
      node: created[0]?.toView() ?? null,
    }
  }
  const node = getDaqController().create(body)
  recordOps({
    actor: user.id,
    actorName: user.name,
    actorKind: 'user',
    action: 'daq.node.create',
    kind: 'daq',
    targetKind: 'daq-node',
    targetId: node.id,
    summary: `创建数采节点「${node.name}」(driver=${node.driver})`,
    lineId: node.lineId ?? '',
    detail: { driver: node.driver, templateRef: node.templateRef },
  })
  return { node: node.toView() }
})
