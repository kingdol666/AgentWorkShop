/**
 * RecipeRollBackRepo —— 调控闭环持久化仓库(dcw-rollback.json)。
 *
 * 两个集合:
 *  - anchors[]  参数变更锚点(append-only 无上限:参数全量在册,永不淘汰)
 *  - records[]  Agent 优化记录(cap 2000 环形;一次调控 step 的完整档案)
 *
 * 与 dcw-line.repo 同构(loadJson/saveJson + 单例);写经 flushDebounced
 * 防落盘放大,启动 restore() 重放(对齐 line-run.ts 崩溃恢复模式)。
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { DcwJournalAnchor, OptimizationRecord } from '../../../../shared/dcw-protocol'
import { loadJsonFile, saveJsonFileAtomic } from '../json-store.mjs'

const DATA_DIR = process.cwd().endsWith('server')
  ? 'data'
  : path.join(process.cwd(), 'server', 'data')
const ROLLBACK_PATH = path.join(DATA_DIR, 'dcw-rollback.json')

const RECORDS_CAP = 2000

interface RollbackDb {
  anchors: DcwJournalAnchor[]
  records: OptimizationRecord[]
}

function loadDb(): RollbackDb {
  const parsed = loadJsonFile(ROLLBACK_PATH, { anchors: [], records: [] }) as Partial<RollbackDb>
  return { anchors: parsed.anchors ?? [], records: parsed.records ?? [] }
}

export class RecipeRollBackRepo {
  private db: RollbackDb = loadDb()
  private flushTimer: NodeJS.Timeout | null = null

  constructor() {
    this.restore()
  }

  /** 启动重放(崩溃恢复;对齐 line-run.ts 模式) */
  restore(): void {
    // 构造即 loadDb;open 记录保持 open,由 manager 的 sweep 评估继续接管
    if (this.db.records.some(r => r.status === 'open')) {
      console.log(`[recipe-rollback] 恢复 ${this.db.anchors.length} 锚 / ${this.db.records.filter(r => r.status === 'open').length} 条 open 优化记录`)
    }
  }

  private flushDebounced(): void {
    if (this.flushTimer)
      return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushNow()
    }, 1500)
    this.flushTimer.unref?.()
  }

  flushNow(): void {
    try {
      saveJsonFileAtomic(ROLLBACK_PATH, this.db)
    }
    catch (err) {
      console.error('[recipe-rollback] 落盘失败:', err)
    }
  }

  // ---------- anchors(append-only) ----------

  appendAnchor(a: Omit<DcwJournalAnchor, 'id' | 'at'> & { id?: string, at?: string }): DcwJournalAnchor {
    const anchor: DcwJournalAnchor = { ...a, id: a.id ?? `anc-${randomUUID().slice(0, 8)}`, at: a.at ?? new Date().toISOString() }
    this.db.anchors.push(anchor)
    this.flushDebounced()
    return anchor
  }

  lastAnchorOf(nodeId: string): DcwJournalAnchor | undefined {
    for (let i = this.db.anchors.length - 1; i >= 0; i--) {
      if (this.db.anchors[i]!.nodeId === nodeId)
        return this.db.anchors[i]
    }
    return undefined
  }

  /** 该节点上一个「有效基线」锚:prevValue≠newValue 的最近一条(单步回退目标) */
  lastStableAnchor(nodeId: string): DcwJournalAnchor | undefined {
    for (let i = this.db.anchors.length - 1; i >= 0; i--) {
      const a = this.db.anchors[i]!
      if (a.nodeId === nodeId && a.prevValue != null && a.prevValue !== a.newValue)
        return a
    }
    return undefined
  }

  anchorById(id: string): DcwJournalAnchor | undefined {
    return this.db.anchors.find(a => a.id === id)
  }

  /** 指定时刻之前该节点最近的稳定锚(批次级回退用) */
  lastStableBefore(nodeId: string, atMs: number): DcwJournalAnchor | undefined {
    for (let i = this.db.anchors.length - 1; i >= 0; i--) {
      const a = this.db.anchors[i]!
      if (a.nodeId !== nodeId || a.prevValue == null || a.prevValue === a.newValue)
        continue
      if (Date.parse(a.at) <= atMs)
        return a
    }
    return undefined
  }

  listAnchors(filter: { nodeId?: string, lineId?: string, source?: string, limit?: number }): DcwJournalAnchor[] {
    let list = [...this.db.anchors].reverse()
    if (filter.nodeId)
      list = list.filter(a => a.nodeId === filter.nodeId)
    if (filter.lineId)
      list = list.filter(a => a.lineId === filter.lineId)
    if (filter.source)
      list = list.filter(a => a.source === filter.source)
    return list.slice(0, filter.limit ?? 100)
  }

  /** 最近一次回退锚(冷却判断用) */
  lastRollbackAnchor(nodeId: string): DcwJournalAnchor | undefined {
    for (let i = this.db.anchors.length - 1; i >= 0; i--) {
      const a = this.db.anchors[i]!
      if (a.nodeId === nodeId && a.source === 'rollback')
        return a
    }
    return undefined
  }

  // ---------- records(优化记录) ----------

  insertRecord(r: Omit<OptimizationRecord, 'id' | 'createdAt'> & { id?: string, createdAt?: string }): OptimizationRecord {
    const record: OptimizationRecord = { ...r, id: r.id ?? `opt-${randomUUID().slice(0, 8)}`, createdAt: r.createdAt ?? new Date().toISOString() }
    this.db.records.push(record)
    if (this.db.records.length > RECORDS_CAP)
      this.db.records.splice(0, this.db.records.length - RECORDS_CAP)
    this.flushDebounced()
    return record
  }

  byId(id: string): OptimizationRecord | undefined {
    return this.db.records.find(r => r.id === id)
  }

  openRecordOf(nodeId: string): OptimizationRecord | undefined {
    return this.db.records.find(r => r.nodeId === nodeId && r.status === 'open')
  }

  updateRecord(id: string, patch: Partial<OptimizationRecord>): OptimizationRecord | undefined {
    const r = this.byId(id)
    if (!r)
      return undefined
    Object.assign(r, patch)
    this.flushDebounced()
    return r
  }

  listRecords(filter: { lineId?: string, recipeId?: string, nodeId?: string, status?: string, agentId?: string, limit?: number }): OptimizationRecord[] {
    let list = [...this.db.records].reverse()
    if (filter.lineId)
      list = list.filter(r => r.lineId === filter.lineId)
    if (filter.recipeId)
      list = list.filter(r => r.recipeId === filter.recipeId)
    if (filter.nodeId)
      list = list.filter(r => r.nodeId === filter.nodeId)
    if (filter.status)
      list = list.filter(r => r.status === filter.status)
    if (filter.agentId)
      list = list.filter(r => r.agentId === filter.agentId)
    return list.slice(0, filter.limit ?? 100)
  }

  /** 该节点的自动回退链长(防乒乓:链上已发生的回退记录数) */
  chainRollbackCount(nodeId: string): number {
    return this.db.records.filter(r => r.nodeId === nodeId && r.status === 'rolled-back').length
  }

  stats(): { anchors: number, records: number, open: number } {
    return { anchors: this.db.anchors.length, records: this.db.records.length, open: this.db.records.filter(r => r.status === 'open').length }
  }
}

const g = globalThis as typeof globalThis & { __recipeRollBackRepo?: RecipeRollBackRepo }

export function getRecipeRollBackRepo(): RecipeRollBackRepo {
  g.__recipeRollBackRepo ??= new RecipeRollBackRepo()
  return g.__recipeRollBackRepo
}
