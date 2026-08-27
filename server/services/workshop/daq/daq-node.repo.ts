/**
 * DaqNode 持久化仓库 —— 对象快照落盘(server/data/daqs.json),与 DeviceTwinRepo 同风格。
 * 进程内缓存 + 防抖写盘(采样只改 value/state,若逐帧同步落盘会 fs 抖动;
 * 配置类变更立即刷盘,读数变更走 5s 防抖)。
 */

import fs from 'node:fs'
import path from 'node:path'
import { DaqNode } from './daq-node'

const DB_PATH = process.cwd().endsWith('server')
  ? 'data/daqs.json'
  : path.join(process.cwd(), 'server', 'data', 'daqs.json')

function load(): DaqNode[] {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
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
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
      fs.writeFileSync(DB_PATH, JSON.stringify(this.list.map(n => n.toRow()), null, 2), 'utf-8')
    }
    catch (err) {
      console.error('[daq] 快照落盘失败:', err)
    }
  }

  /** 读数落盘防抖(采样循环每帧调用;5s 合并一次磁盘写) */
  flushDebounced(ms = 5000): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushNow()
    }, ms)
    this.flushTimer.unref?.()
  }
}

let singleton: DaqNodeRepo | null = null

export function getDaqNodeRepo(): DaqNodeRepo {
  singleton ??= new DaqNodeRepo()
  return singleton
}
