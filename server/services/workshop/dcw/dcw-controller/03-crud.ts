/**
 * DcwControllerLayer03 —— 节点 CRUD
 * (分层 4/10,承 DcwControllerLayer02;方法体与原文件逐行一致)
 */
import { DcwControllerLayer02 } from './02-control'
import type { DcwCreateInput, DcwPatchInput } from './types'
import { AppError, ErrorCodes } from '../../../../utils/errors'
import { DcwNode } from '../dcw-node'
import { dcwKeyFromRef, normalizeDataTransform } from '../../../../../shared/dcw-protocol'
import { findDcwTemplate } from '../dcw-templates'
import { getDcwLineRepo } from '../dcw-line.repo'
import { getDcwParamRepo } from '../param-map.repo'
import { normalizeDcwDriverKind } from '../drivers'
import { randomUUID } from 'node:crypto'

export abstract class DcwControllerLayer03 extends DcwControllerLayer02 {
  create(input: DcwCreateInput): DcwNode {
    this.ensureLoop()
    if (!input.templateRef) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'templateRef 必填:控制节点必须绑定工艺参数模板')
    }
    const tpl = findDcwTemplate(dcwKeyFromRef(input.templateRef))
    if (!tpl) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, `未知控制模板: ${input.templateRef}`)
    }
    const seq = this.repo.all().filter(n => n.templateKey === dcwKeyFromRef(input.templateRef!)).length + 1
    const node = new DcwNode({
      id: `dw-${randomUUID().slice(0, 8)}`,
      templateRef: input.templateRef,
      name: input.name ?? `${tpl.name} ${String(seq).padStart(2, '0')}`,
      driver: input.driver ? normalizeDcwDriverKind(input.driver) : undefined,
      driverConfig: input.driverConfig ?? {},
      transform: normalizeDataTransform(input.transform),
      enabled: input.enabled,
      holdIntervalMs: input.holdIntervalMs ?? null,
      readIntervalMs: input.readIntervalMs ?? null,
      unit: input.unit,
      decimals: input.decimals,
      min: input.min,
      max: input.max,
      deviceBindingId: input.deviceBindingId ?? null,
      deviceIds: input.deviceIds ?? (input.deviceBindingId ? [input.deviceBindingId] : []),
      posX: input.posX,
      posZ: input.posZ,
      lineId: input.lineId,
      semantics: input.semantics,
      writeLockSeconds: input.writeLockSeconds,
    })
    this.repo.insert(node)
    // 工艺参数映射面:节点创建即自动生成同名映射(用户/Agent 的参数语义面;
    // PLC 寻址细节仍封装在节点驱动配置内)。失败不阻断节点创建(可事后手工补建)。
    getDcwParamRepo().ensureForNode(node)
    this.syncRuntimes()
    this.emitNodeChanged('added', node)
    return node
  }

  patch(id: string, patch: DcwPatchInput): DcwNode {
    const node = this.repo.byId(id)
    if (!node) throw new AppError(404, ErrorCodes.NOT_FOUND, `控制节点不存在: ${id}`)
    let rearm = false
    if (patch.name !== undefined) node.name = patch.name
    if (patch.driver !== undefined) node.driver = normalizeDcwDriverKind(patch.driver)
    if (patch.driverConfig !== undefined) node.driverConfig = { ...node.driverConfig, ...patch.driverConfig }
    if (patch.transform !== undefined) {
      if (patch.transform.kind === 'linear' && (!Number.isFinite(Number(patch.transform.scale)) || Number(patch.transform.scale) === 0)) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, '标定系数 scale 必须为非零数字(物理值 = scale × PLC值 + offset)')
      }
      node.transform = normalizeDataTransform(patch.transform)
    }
    if (patch.unit !== undefined) node.unit = patch.unit
    // decimals 必须 0..6 整数:它同时喂给 toFixed() —— 越界值会在**驱动已经写进 PLC 之后**
    // 由 applyWriteResult/applyReadResult 抛 RangeError,造成「硬件已改、账本无记录、
    // 调用方吃 500」(审计实测:decimals=101 → PLC 写入成功、无锚点、无写历史)。
    // 在校验入口一次性拒掉,别让脏值走到写路径。
    if (patch.decimals !== undefined) {
      const d = Number(patch.decimals)
      if (!Number.isInteger(d) || d < 0 || d > 6) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `decimals 必须为 0..6 的整数(当前: ${String(patch.decimals)})`)
      }
      node.decimals = d
    }
    if (patch.min !== undefined) {
      const v = Number(patch.min)
      if (!Number.isFinite(v)) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `min 必须为有限数字(当前: ${String(patch.min)})`)
      node.min = v
    }
    if (patch.max !== undefined) {
      const v = Number(patch.max)
      if (!Number.isFinite(v)) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `max 必须为有限数字(当前: ${String(patch.max)})`)
      node.max = v
    }
    // 量程交叉校验放在两者都应用之后:min>max 会让 writeTolerance 变负、越界判定恒真
    if (node.max < node.min) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `量程无效:max(${node.max}) 不得小于 min(${node.min})`)
    }
    if (patch.holdIntervalMs !== undefined) {
      node.holdIntervalMs = patch.holdIntervalMs == null ? null : Math.max(0, Math.min(3_600_000, Math.round(patch.holdIntervalMs)))
      rearm = true
    }
    if (patch.readIntervalMs !== undefined) {
      node.readIntervalMs = patch.readIntervalMs == null ? null : Math.max(0, Math.min(3_600_000, Math.round(patch.readIntervalMs)))
      rearm = true
    }
    if (patch.enabled !== undefined) {
      node.enabled = patch.enabled
      // 暂停/恢复的状态同步:暂停 → offline(暂停控制);恢复 → 回到待机(等下次写 ACK 转 ok)
      if (!patch.enabled) node.state = 'offline'
      else if (node.state === 'offline') node.state = 'idle'
      rearm = true
    }
    if (patch.posX !== undefined) node.posX = patch.posX
    if (patch.posZ !== undefined) node.posZ = patch.posZ
    if (patch.lineId !== undefined) {
      const lid = String(patch.lineId)
      if (lid && !getDcwLineRepo().byId(lid)) throw new AppError(404, ErrorCodes.NOT_FOUND, `产线不存在: ${lid}`)
      node.lineId = lid
    }
    if (patch.semantics !== undefined) node.semantics = String(patch.semantics)
    if (patch.writeLockSeconds !== undefined) {
      const v = Number(patch.writeLockSeconds)
      if (!Number.isFinite(v) || v < 0 || v > 3600) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `writeLockSeconds 必须为 0..3600 的整数秒(当前: ${String(patch.writeLockSeconds)})`)
      }
      node.writeLockSeconds = Math.round(v)
    }
    if (rearm) this.runtimes.get(id)?.rearm()
    this.repo.flushNow()
    this.emitNodeChanged('updated', node)
    return node
  }

  remove(id: string): void {
    const node = this.repo.byId(id)
    if (!node) throw new AppError(404, ErrorCodes.NOT_FOUND, `控制节点不存在: ${id}`)
    this.repo.remove(id)
    this.runtimes.delete(id)
    // 级联清理:工艺参数映射面随执行节点删除(参数不存在悬空引用)
    getDcwParamRepo().removeForNode(id)
    // 级联清理:该节点的 Agent 绑定移除,挂起中的手动审批按失效收敛
    void import('../../agents/node-bindings.repo').then(({ getAgentNodeBindingRepo }) => {
      const repo = getAgentNodeBindingRepo()
      for (const b of repo.byNode(id)) {
        void import('../../agents/tool-approvals').then(({ getToolApprovals }) => {
          getToolApprovals().cancelPendingFor(b.agentId, id)
        }).catch(() => {})
        repo.removeAgentNode(b.agentId, id, 'dcw')
      }
    }).catch(() => {})
    this.emitNodeChanged('removed', node)
  }
}
