/**
 * DaqNode 持久化仓库 —— 对象快照落盘(server/data/daqs.json),与 DeviceTwinRepo 同风格。
 * 进程内缓存 + 防抖写盘(采样只改 value/state,若逐帧同步落盘会 fs 抖动;
 * 配置类变更立即刷盘,读数变更走 5s 防抖)。
 */

import { createLogger } from '../logger'
import { join } from 'node:path'
import { DaqNode } from './daq-node'
import { ensureDataDir } from '@/shared/config/home.mjs'
import { loadJsonFile, saveJsonFileAtomic } from '../json-store.mjs'

const log = createLogger('daq.node-repo')

// 配置根 .AgentWorkShop/data（ensureDataDir 自动迁移旧 cwd/server/data 位置）
const DB_PATH = join(ensureDataDir(), 'daqs.json')

function load(): DaqNode[] {
  try {
    const parsed = loadJsonFile(DB_PATH, null)
    return Array.isArray(parsed) ? parsed.map(r => DaqNode.fromRow(r as Record<string, unknown>)) : []
  }
  catch {
    return []
  }
}

class DaqNodeRepo {
  private list: DaqNode[]
  private flushTimer: NodeJS.Timeout | null = null

  constructor() {
    this.list = load()
  }

  /** 磁盘 ↔ 内存同构:全量对象快照(启动恢复 / 诊断导出) */
  snapshot(): DaqNode[] {
    return [...this.list]
  }

  all(): DaqNode[] {
    return this.list
  }

  byId(id: string): DaqNode | undefined {
    return this.list.find(n => n.id === id)
  }

  insert(node: DaqNode): void {
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

  /** 立即落盘(配置类 CRUD;同步写,量小无碍) */
  flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    try {
      saveJsonFileAtomic(DB_PATH, this.list.map(n => n.toRow()))
    }
    catch (err) {
      log.error('[daq] 快照落盘失败:', err)
    }
  }
}

// 单例挂 globalThis(与 dcw-recipe.repo 同型):dev HMR 重建模块时保住实例,
// 否则 nitro 重建后的 DaqController 仍持旧 repo,运行时内存态分叉
const g = globalThis as typeof globalThis & { __daqNodeRepo?: DaqNodeRepo }

export function getDaqNodeRepo(): DaqNodeRepo {
  g.__daqNodeRepo ??= new DaqNodeRepo()
  return g.__daqNodeRepo
}
