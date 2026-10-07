/**
 * DcwNode 持久化仓库 —— 对象快照落盘(server/data/dcws.json),与 DaqNodeRepo 同风格。
 * 配置类变更立即刷盘;写值变更走短窗防抖(保写心跳按 holdIntervalMs 周期重下发,
 * 同步全量重写会随节点数放大;防抖窗口内崩溃丢失的设定值可从 PLC 回读恢复)。
 */

import { createLogger } from '../logger'
import { join } from 'node:path'
import { DcwNode } from './dcw-node'
import { ensureDataDir } from '@/shared/config/home.mjs'
import { loadJsonFile, saveJsonFileAtomic } from '../json-store.mjs'
import { migrateDcwDriverKind } from './drivers'

const log = createLogger('dcw.node-repo')

// 配置根 .AgentWorkShop/data（ensureDataDir 自动迁移旧 cwd/server/data 位置）
const DB_PATH = join(ensureDataDir(), 'dcws.json')

function load(): { nodes: DcwNode[], migrated: number } {
  try {
    const parsed = loadJsonFile(DB_PATH, null)
    if (!Array.isArray(parsed)) return { nodes: [], migrated: 0 }
    let migrated = 0
    const nodes = (parsed as Record<string, unknown>[]).map((r) => {
      const node = DcwNode.fromRow(r)
      // P0-5 启动迁移:旧命名归一(modbus→modbus-tcp 等);无法归一的未知 kind
      // 降级 mock 并打标(fail-visible,不砖启动)—— 该节点后续写路径显式失败待重配。
      if (r.driver != null) {
        const m = migrateDcwDriverKind(String(r.driver))
        if (m.kind !== node.driver) {
          node.driver = m.kind
          migrated++
          if (m.downgraded) {
            node.lastError = `驱动「${String(r.driver)}」未注册,已降级 mock —— 请重新配置节点驱动后重写`
            log.warn(`[dcw] 节点 ${node.id}(${node.name}) 驱动「${String(r.driver)}」未注册,已降级 mock`)
          }
        }
      }
      return node
    })
    return { nodes, migrated }
  }
  catch {
    return { nodes: [], migrated: 0 }
  }
}

class DcwNodeRepo {
  private list: DcwNode[]
  private flushTimer: NodeJS.Timeout | null = null

  constructor() {
    const { nodes, migrated } = load()
    this.list = nodes
    // 迁移结果立即落盘(别名归一/降级打标持久化,避免每次启动重复告警)
    if (migrated > 0) this.flushNow()
  }

  all(): DcwNode[] {
    return this.list
  }

  byId(id: string): DcwNode | undefined {
    return this.list.find(n => n.id === id)
  }

  insert(node: DcwNode): void {
    this.list.push(node)
    this.flushNow()
  }

  remove(id: string): boolean {
    const before = this.list.length
    this.list = this.list.filter(n => n.id !== id)
    if (this.list.length !== before) {
      this.flushNow()
      return true
    }
    return false
  }

  /** 写值路径防抖落盘(1.5s 合并窗;保写心跳多节点同拍只落一次盘) */
  flushDebounced(): void {
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null
      this.flushNow()
    }, 1500)
    this.flushTimer.unref?.()
  }

  flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    try {
      saveJsonFileAtomic(DB_PATH, this.list.map(n => n.toRow()))
    }
    catch (err) {
      log.error('[dcw] 快照落盘失败:', err)
    }
  }
}

let singleton: DcwNodeRepo | null = null

export function getDcwNodeRepo(): DcwNodeRepo {
  singleton ??= new DcwNodeRepo()
  return singleton
}
