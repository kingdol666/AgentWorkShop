/**
 * DaqControllerLayer07 —— 节点 CRUD 与设备绑定
 * (分层 8/9,承 DaqControllerLayer06;方法体与原文件逐行一致)
 */
import { DaqControllerLayer06 } from './06-runtime-control'
import type { DaqCreateInput, DaqPatchInput } from './types'
import { AppError, ErrorCodes } from '../../../../utils/errors'
import { DaqNode } from '../daq-node'
import { daqKeyFromRef, normalizeDataTransform } from '../../../../../shared/daq-protocol'
import { findDaqTemplate } from '../daq-templates'
import { getDaqHostPorts } from '../host-ports'
import { normalizeDriverKind } from '../drivers'
import { randomUUID } from 'node:crypto'

export abstract class DaqControllerLayer07 extends DaqControllerLayer06 {
  create(input: DaqCreateInput): DaqNode {
    this.ensureLoop()
    // 节点必绑模板:模板是量程/单位/物理语义(ch)的唯一来源,无模板节点在孪生
    // 场景无元信息可展示(UI 全路径经模板创建;直接 REST 裸调在此收口)
    if (!input.templateRef) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'templateRef 必填:数采节点必须绑定信号模板')
    }
    const tpl = findDaqTemplate(daqKeyFromRef(input.templateRef))
    if (!tpl) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, `未知数采模板: ${input.templateRef}`)
    }
    const seq = this.repo.all().filter(n => n.templateKey === daqKeyFromRef(input.templateRef!)).length + 1
    const node = new DaqNode({
      id: `dn-${randomUUID().slice(0, 8)}`,
      templateRef: input.templateRef,
      name: input.name ?? (tpl ? `${tpl.name} ${String(seq).padStart(2, '0')}` : (input.driver && input.driver !== 'mock' ? `${input.driver.toUpperCase()} 通道` : undefined)),
      driver: input.driver ? normalizeDriverKind(input.driver) : undefined,
      driverConfig: input.driverConfig ?? {},
      transform: normalizeDataTransform(input.transform),
      enabled: input.enabled,
      intervalMs: input.intervalMs == null ? null : Math.max(this.minIntervalMs, Math.min(60_000, Math.round(input.intervalMs))),
      publishIntervalMs: input.publishIntervalMs == null
        ? null
        : Math.max(this.minPublishIntervalMs, Math.min(60_000, Math.round(input.publishIntervalMs))),
      unit: input.unit,
      decimals: input.decimals,
      min: input.min,
      max: input.max,
      warnLow: input.warnLow,
      warnHigh: input.warnHigh,
      deviceBindingId: input.deviceBindingId ?? null,
      posX: input.posX,
      posZ: input.posZ,
      lineId: input.lineId,
      semantics: input.semantics,
    })
    this.repo.insert(node)
    this.syncRuntimes() // 新节点即刻入网关注册表(边缘运行时实例化)
    this.emitNodeChanged('added', node)
    return node
  }

  patch(id: string, patch: DaqPatchInput): DaqNode {
    const node = this.repo.byId(id)
    if (!node) throw Object.assign(new Error(`数采节点不存在: ${id}`), { status: 404 })
    if (patch.name !== undefined) node.name = patch.name
    if (patch.driver !== undefined) node.driver = normalizeDriverKind(patch.driver)
    if (patch.driverConfig !== undefined) node.driverConfig = { ...node.driverConfig, ...patch.driverConfig }
    if (patch.transform !== undefined) {
      if (patch.transform.kind === 'linear' && (!Number.isFinite(Number(patch.transform.scale)) || Number(patch.transform.scale) === 0)) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, '标定系数 scale 必须为非零数字(物理值 = scale × PLC值 + offset)')
      }
      node.transform = normalizeDataTransform(patch.transform)
    }
    if (patch.unit !== undefined) node.unit = patch.unit
    if (patch.decimals !== undefined) node.decimals = patch.decimals
    if (patch.min !== undefined) node.min = patch.min
    if (patch.max !== undefined) node.max = patch.max
    if (patch.warnLow !== undefined) node.warnLow = patch.warnLow
    if (patch.warnHigh !== undefined) node.warnHigh = patch.warnHigh
    let rearm = false
    if (patch.intervalMs !== undefined) {
      node.intervalMs = patch.intervalMs == null ? null : Math.max(this.minIntervalMs, Math.min(60_000, Math.round(patch.intervalMs)))
      rearm = true
    }
    if (patch.publishIntervalMs !== undefined) {
      // 下发节拍:null=跟随全局;否则钳到 [minPublishIntervalMs, 60s]
      // (minPublishIntervalMs 默认 0 → 0 仍表示「每帧随采样」语义)
      node.publishIntervalMs = patch.publishIntervalMs == null
        ? null
        : Math.max(this.minPublishIntervalMs, Math.min(60_000, Math.round(patch.publishIntervalMs)))
      rearm = true
    }
    if (patch.enabled !== undefined) {
      node.enabled = patch.enabled
      if (!patch.enabled) node.state = 'offline'
      rearm = true
    }
    if (rearm) this.runtimes.get(id)?.rearm() // 元数据变更即刻生效(独立运行时节拍重置)
    if (patch.posX !== undefined) node.posX = patch.posX
    if (patch.posZ !== undefined) node.posZ = patch.posZ
    if (patch.lineId !== undefined) {
      const lid = String(patch.lineId)
      if (lid && !getDaqHostPorts()?.lineRun.lineExists(lid)) throw new AppError(404, ErrorCodes.NOT_FOUND, `产线不存在: ${lid}`)
      node.lineId = lid
    }
    if (patch.semantics !== undefined) node.semantics = String(patch.semantics)
    if (node.value != null) node.state = node.deriveState(node.value)
    this.repo.flushNow()
    this.emitNodeChanged('updated', node)
    return node
  }

  remove(id: string): void {
    const node = this.repo.byId(id)
    if (!node) throw Object.assign(new Error(`数采节点不存在: ${id}`), { status: 404 })
    this.repo.remove(id)
    this.runtimes.delete(id) // 运行时随节点注销
    // 键为 `${nodeId}::${metricKey}` 的告警态:节点删除后必须一并清理,
    // 否则「建-删节点」循环会让该 Map 单调增长(长跑内存泄漏),且重建同名节点会继承陈旧告警态。
    const prefix = `${id}::`
    for (const key of this.metricStates.keys()) {
      if (key.startsWith(prefix)) this.metricStates.delete(key)
    }
    // 级联清理:该节点的 Agent 绑定移除
    void import('../../agents/node-bindings.repo').then(({ getAgentNodeBindingRepo }) => {
      getAgentNodeBindingRepo().removeNode(id)
    }).catch(() => {})
    this.emitNodeChanged('removed', node)
  }

  bind(id: string, deviceId: string | null): DaqNode {
    const node = this.repo.byId(id)
    if (!node) throw new AppError(404, ErrorCodes.NOT_FOUND, `数采节点不存在: ${id}`)
    if (deviceId && !getDaqHostPorts()?.telemetry.deviceExists(deviceId)) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, `目标设备不存在: ${deviceId}`)
    }
    // 排他语义保留(deviceId=null 清空全部);多对多增删用 bindDevice/unbindDeviceNode/setDeviceBindings
    node.deviceIds = deviceId ? [deviceId] : []
    node.deviceBindingId = deviceId
    this.repo.flushNow()
    this.emitNodeChanged('updated', node)
    return node
  }

  /** 追加一台绑定设备((节点,设备)对唯一;已绑定则幂等返回) */
  bindDevice(id: string, deviceId: string): DaqNode {
    const node = this.repo.byId(id)
    if (!node) throw new AppError(404, ErrorCodes.NOT_FOUND, `数采节点不存在: ${id}`)
    if (!getDaqHostPorts()?.telemetry.deviceExists(deviceId)) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, `目标设备不存在: ${deviceId}`)
    }
    if (node.deviceIds.includes(deviceId)) return node
    node.deviceIds = [...node.deviceIds, deviceId]
    node.deviceBindingId = node.deviceIds[0] ?? null
    this.repo.flushNow()
    this.emitNodeChanged('updated', node)
    return node
  }

  /** 解绑一台设备(其余绑定保留) */
  unbindDeviceNode(id: string, deviceId: string): DaqNode {
    const node = this.repo.byId(id)
    if (!node) throw Object.assign(new Error(`数采节点不存在: ${id}`), { status: 404 })
    if (!node.deviceIds.includes(deviceId)) return node
    node.deviceIds = node.deviceIds.filter(d => d !== deviceId)
    node.deviceBindingId = node.deviceIds[0] ?? null
    this.repo.flushNow()
    this.emitNodeChanged('updated', node)
    return node
  }

  /** 整体设定绑定设备列表(去重、校验存在性;全量替换) */
  setDeviceBindings(id: string, deviceIds: string[]): DaqNode {
    const node = this.repo.byId(id)
    if (!node) throw Object.assign(new Error(`数采节点不存在: ${id}`), { status: 404 })
    const unique = [...new Set(deviceIds.map(String).filter(Boolean))]
    for (const d of unique) {
      if (!getDaqHostPorts()?.telemetry.deviceExists(d)) {
        throw new AppError(404, ErrorCodes.NOT_FOUND, `目标设备不存在: ${d}`)
      }
    }
    node.deviceIds = unique
    node.deviceBindingId = unique[0] ?? null
    this.repo.flushNow()
    this.emitNodeChanged('updated', node)
    return node
  }

  /** 设备删除级联:解绑其全部 DAQ 节点 + 清回写积压 + 广播(链路不再依赖下次回写失败自愈)。
   *  flushNow(全量 JSON 序列化落盘)移出循环:逐节点落盘会随匹配数重复序列化整库 */
  unbindDevice(deviceId: string): void {
    this.pendingBackfill.delete(deviceId)
    this.siblingsCache.delete(deviceId)
    // twinPushAt 以 twinId 为键:设备删除后同样要清,否则节流表随设备增删单调增长
    this.twinPushAt.delete(deviceId)
    let touched = false
    for (const node of this.repo.all()) {
      if (!node.deviceIds.includes(deviceId)) continue
      node.deviceIds = node.deviceIds.filter(d => d !== deviceId)
      node.deviceBindingId = node.deviceIds[0] ?? null
      touched = true
      this.emitNodeChanged('updated', node)
    }
    if (touched) this.repo.flushNow()
  }
}
