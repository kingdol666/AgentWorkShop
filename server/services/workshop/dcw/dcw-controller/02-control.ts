/**
 * DcwControllerLayer02 —— 视图状态 / 广播装配 / 启停暂停恢复
 * (分层 3/10,承 DcwControllerLayer01;方法体与原文件逐行一致)
 */
import { DcwControllerLayer01 } from './01-actuation'
import type { BroadcastFn } from './types'
import type { DcwNodeView } from '../../../../../shared/dcw-protocol'
import type { DcwNode } from '../dcw-node'
import { getRecipeRollBackManager } from '../recipe-rollback-manager'

export abstract class DcwControllerLayer02 extends DcwControllerLayer01 {
  setBroadcast(fn: BroadcastFn | null): void {
    this.broadcast = fn
    // 调控闭环 WS 帧(dcw.optimization.changed)与既有帧同一广播通道
    getRecipeRollBackManager().setBroadcast(fn)
  }

  // ---------- 查询 ----------

  listViews(): DcwNodeView[] {
    this.ensureLoop()
    return this.repo.all().map(n => n.toView())
  }

  byId(id: string): DcwNode | undefined {
    return this.repo.byId(id)
  }

  controllerState() {
    // 单次遍历(hardening PERF-1):status 高频路径不再对全表多次 all()
    const nodes = this.repo.all()
    return {
      running: this.running,
      nodesTotal: nodes.length,
      nodesOnline: this.running ? nodes.filter(n => n.enabled).length : 0,
      writesTotal: this.writesTotal,
      writesFailed: this.writesFailed,
    }
  }

  // ---------- 网关全局 ----------

  startAll() {
    this.running = true
    // 恢复控制:因「暂停全部控制」转 offline 的启用节点回待机(暂停态与恢复态对称)
    for (const n of this.repo.all()) {
      if (n.enabled && n.state === 'offline') n.state = 'idle'
    }
    this.ensureLoop()
    this.broadcast?.('dcw.controller', this.controllerState())
    return this.controllerState()
  }

  stopAll() {
    this.running = false
    for (const n of this.repo.all()) {
      if (n.enabled && n.value != null) n.state = 'offline'
    }
    this.broadcast?.('dcw.controller', this.controllerState())
    return this.controllerState()
  }

  /**
   * 暂停全部控制 → 网关停止;恢复全部控制 → 网关启动。
   * 节点启停与网关暂停完全独立:enabled 标志是唯一下发资格,恢复后只有
   * enabled=true(即暂停时刻在控制的那批)的节点恢复;暂停前/暂停期间
   * 手动停用的节点保持停用,不会被自动拉起。
   */
  pauseAll() {
    return this.stopAll()
  }

  resumeAll() {
    return this.startAll()
  }

  // ---------- 节点 CRUD(单点控制入口)----------
}
