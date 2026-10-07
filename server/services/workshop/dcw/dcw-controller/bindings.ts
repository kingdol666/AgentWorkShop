/**
 * DcwControllerBindings —— 设备绑定
 * (拆分层,承 DcwControllerCrud;方法体与原文件逐行一致)
 */
import { DcwControllerCrud } from './crud'
import { AppError, ErrorCodes } from '../../../../utils/errors'
import type { DcwNode } from '../dcw-node'
import { getDeviceTwinRepo } from '../../assets/device-twin.repo'

export abstract class DcwControllerBindings extends DcwControllerCrud {
  /** P0-1 变更点清值:设备绑定变更后,旧 value 不再指向当前写目标 —— 清值停驻保写,
   *  须新写成功才复驻。否则换绑残留节点的保写心跳会把陈旧设定值周期写向新设备
   *  (10-07 五节点 66/75/60/185/215 污染事故根因①)。 */
  protected invalidateHoldValue(node: DcwNode): void {
    if (node.value == null) return
    node.value = null
    this.runtimes.get(node.id)?.rearm()
  }

  bind(id: string, deviceId: string | null): DcwNode {
    const node = this.repo.byId(id)
    if (!node) throw new AppError(404, ErrorCodes.NOT_FOUND, `控制节点不存在: ${id}`)
    if (deviceId) {
      const twin = getDeviceTwinRepo().findById(deviceId)
      if (!twin) throw new AppError(404, ErrorCodes.NOT_FOUND, `目标设备不存在: ${deviceId}`)
    }
    // 排他语义保留;多对多增删用 bindDevice/unbindDeviceNode/setDeviceBindings
    node.deviceIds = deviceId ? [deviceId] : []
    node.deviceBindingId = deviceId
    this.invalidateHoldValue(node)
    this.repo.flushNow()
    this.emitNodeChanged('updated', node)
    return node
  }

  /** 追加一台绑定设备((节点,设备)对唯一;幂等) */
  bindDevice(id: string, deviceId: string): DcwNode {
    const node = this.repo.byId(id)
    if (!node) throw new AppError(404, ErrorCodes.NOT_FOUND, `控制节点不存在: ${id}`)
    const twin = getDeviceTwinRepo().findById(deviceId)
    if (!twin) throw new AppError(404, ErrorCodes.NOT_FOUND, `目标设备不存在: ${deviceId}`)
    if (node.deviceIds.includes(deviceId)) return node
    node.deviceIds = [...node.deviceIds, deviceId]
    node.deviceBindingId = node.deviceIds[0] ?? null
    this.invalidateHoldValue(node)
    this.repo.flushNow()
    this.emitNodeChanged('updated', node)
    return node
  }

  /** 解绑一台设备(其余绑定保留) */
  unbindDeviceNode(id: string, deviceId: string): DcwNode {
    const node = this.repo.byId(id)
    if (!node) throw new AppError(404, ErrorCodes.NOT_FOUND, `控制节点不存在: ${id}`)
    if (!node.deviceIds.includes(deviceId)) return node
    node.deviceIds = node.deviceIds.filter(d => d !== deviceId)
    node.deviceBindingId = node.deviceIds[0] ?? null
    this.invalidateHoldValue(node)
    this.repo.flushNow()
    this.emitNodeChanged('updated', node)
    return node
  }

  /** 整体设定绑定设备列表(去重、校验存在性;全量替换) */
  setDeviceBindings(id: string, deviceIds: string[]): DcwNode {
    const node = this.repo.byId(id)
    if (!node) throw new AppError(404, ErrorCodes.NOT_FOUND, `控制节点不存在: ${id}`)
    const unique = [...new Set(deviceIds.map(String).filter(Boolean))]
    for (const d of unique) {
      if (!getDeviceTwinRepo().findById(d)) {
        throw new AppError(404, ErrorCodes.NOT_FOUND, `目标设备不存在: ${d}`)
      }
    }
    node.deviceIds = unique
    node.deviceBindingId = unique[0] ?? null
    this.invalidateHoldValue(node)
    this.repo.flushNow()
    this.emitNodeChanged('updated', node)
    return node
  }

  /** 设备删除级联解绑(device-twins 删除路由调用)。flushNow 移出循环(同 daq 侧) */
  unbindDevice(deviceId: string): void {
    let touched = false
    for (const node of this.repo.all()) {
      if (!node.deviceIds.includes(deviceId)) continue
      node.deviceIds = node.deviceIds.filter(d => d !== deviceId)
      node.deviceBindingId = node.deviceIds[0] ?? null
      this.invalidateHoldValue(node)
      touched = true
      this.emitNodeChanged('updated', node)
    }
    if (touched) this.repo.flushNow()
  }

  // ---------- 写命令(上位机核心操作)----------
}
