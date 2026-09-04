/**
 * DcwNode 持久化仓库 —— 对象快照落盘(server/data/dcws.json),与 DaqNodeRepo 同风格。
 * 配置类变更立即刷盘;写值变更走短窗防抖(保写心跳按 holdIntervalMs 周期重下发,
 * 同步全量重写会随节点数放大;防抖窗口内崩溃丢失的设定值可从 PLC 回读恢复)。
 */

import { createLogger } from '../logger'
import path from 'node:path'
import { DcwNode } from './dcw-node'
import { loadJsonFile, saveJsonFileAtomic } from '../json-store.mjs'

const log = createLogger('dcw.node-repo')

const DB_PATH = process.cwd().endsWith('server')
  ? 'data/dcws.json'
  : path.join(process.cwd(), 'server', 'data', 'dcws.json')

function load(): DcwNode[] {
  try {
    const parsed = loadJsonFile(DB_PATH, null)
    return Array.isArray(parsed) ? parsed.map(r => DcwNode.fromRow(r as Record<string, unknown>)) : []
  }
  catch {
    return []
  }
}

class DcwNodeRepo {
  private list: DcwNode[]
  private flushTimer: NodeJS.Timeout | null = null

  constructor() {
    this.list = load()
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
