/**
 * DcwControllerLayer00 —— 字段 / 巡检循环 / 运行时同步 / 宿主
 * (分层 1/10,承 DcwControllerContracts;方法体与原文件逐行一致)
 */
import { DcwControllerContracts } from './contracts'
import type { BroadcastFn } from './types'
import { DEFAULT_READ_INTERVAL_MS, SWEEP_MS } from './helpers'
import type { DcwNode } from '../dcw-node'
import { DcwNodeRuntime } from '../dcw-runtime'
import { getDcwNodeRepo } from '../dcw-node.repo'
import { getRecipeRollBackManager } from '../recipe-rollback-manager'

export abstract class DcwControllerLayer00 extends DcwControllerContracts {
  protected repo = getDcwNodeRepo()
  protected broadcast: BroadcastFn | null = null
  protected timer: NodeJS.Timeout | null = null
  /** 边缘控制运行时注册表(节点 id → 独立运行时) */
  protected runtimes = new Map<string, DcwNodeRuntime>()

  running = true
  protected writesTotal = 0
  protected writesFailed = 0
  /** 写入保持窗注册表(nodeId → lockUntil epoch ms;仅内存,重启即清) */
  protected writeLocks = new Map<string, number>()

  // ---------- 生命周期 ----------

  protected ensureLoop(): void {
    this.syncRuntimes()
    if (this.timer) return
    this.timer = setInterval(() => this.sweep(), SWEEP_MS)
    this.timer.unref?.()
  }

  /** 网关统一调度:保写心跳在各运行时内部自治(单节点写事务不波及邻居);
   *  调控闭环:open 优化记录的系统兜底评估复用本节拍(F1,不建新定时器) */
  protected sweep(): void {
    if (!this.running) return
    const now = Date.now()
    for (const rt of this.runtimes.values()) rt.tick(now)
    getRecipeRollBackManager().evaluateOpenRecords(now)
  }

  protected syncRuntimes(): void {
    const live = new Set<string>()
    for (const node of this.repo.all()) {
      live.add(node.id)
      if (!this.runtimes.has(node.id)) {
        this.runtimes.set(node.id, new DcwNodeRuntime(node, this.host))
      }
    }
    for (const id of [...this.runtimes.keys()]) {
      if (!live.has(id)) this.runtimes.delete(id)
    }
  }

  // ---------- 网关服务面(runtime host)----------

  protected host = {
    running: () => this.running,
    defaults: () => ({ holdIntervalMs: 0, readIntervalMs: DEFAULT_READ_INTERVAL_MS }),
    executeWrite: async (node: DcwNode, eng: number, tolerance: number, recipeRunId: string | null) =>
      this.executeWrite(node, eng, tolerance, recipeRunId),
    executeRead: async (node: DcwNode) => this.executeRead(node),
  }
}
