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
import { join } from 'node:path'
import type { DcwJournalAnchor, OptimizationRecord } from '../../../../shared/dcw-protocol'
import { ensureDataDir } from '@/shared/config/home.mjs'
import { loadJsonFile, saveJsonFileAtomic } from '../json-store.mjs'

// 配置根 .AgentWorkShop/data（ensureDataDir 自动迁移旧 cwd/server/data 位置）
const ROLLBACK_PATH = join(ensureDataDir(), 'dcw-rollback.json')

const RECORDS_CAP = 2000
/**
 * anchors 上限(环形淘汰最旧)。
 * 早先注释自述「append-only 无上限」:anchors 随每次参数变更单调增长,而 flushNow() 是
 * **整库序列化**(anchors + records),保写心跳 + Agent 连续调控下每次落盘的 CPU/IO 线性放大,
 * 且四个 last* 查询各自逆序全扫也随长度线性劣化 —— 长跑必然抖动直至 OOM。
 * 20000 条锚在 1.5s 防抖落盘下约数 MB,既能覆盖任意实际回退窗口,又给出确定上界。
 */
const ANCHORS_CAP = 20000

interface RollbackDb {
  anchors: DcwJournalAnchor[]
  records: OptimizationRecord[]
}

function loadDb(): RollbackDb {
  const parsed = loadJsonFile(ROLLBACK_PATH, { anchors: [], records: [] }) as Partial<RollbackDb>
  const db = { anchors: parsed.anchors ?? [], records: parsed.records ?? [] }
  // 兼容历史无界文件:启动即收敛到上限,避免一次载入就把内存顶满
  if (db.anchors.length > ANCHORS_CAP) db.anchors.splice(0, db.anchors.length - ANCHORS_CAP)
  return db
}

export class RecipeRollBackRepo {
  private db: RollbackDb = loadDb()
  private flushTimer: NodeJS.Timeout | null = null
  /**
   * 每节点倒序锚 id 索引 —— 把 lastAnchorOf / lastStableAnchor / lastStableBefore /
   * lastRollbackAnchor 四个「逆序全扫」降为 O(1)(稳定锚)或短前缀扫描。
   * 之前每次写都触发其中 1~2 次全扫,rollbackRun 更是 N 节点 × O(anchors);
   * anchors 无上限时这是最坏路径,也是调控热路径上最贵的操作。
   */
  private readonly nodeAnchors = new Map<string, DcwJournalAnchor[]>()
  /** 每节点「稳定锚」(prevValue≠newValue)倒序子序列,单步回退直接取头 */
  private readonly stableAnchors = new Map<string, DcwJournalAnchor[]>()
  /** open 优化记录索引(nodeId → record),消除 evaluateOpenRecords 的 500ms 全量扫描 */
  private readonly openByNode = new Map<string, OptimizationRecord>()

  constructor() {
    this.reindex()
    this.restore()
  }

  /** 由 db 重建全部索引(构造与外部文件热替换后调用) */
  private reindex(): void {
    this.nodeAnchors.clear()
    this.stableAnchors.clear()
    this.openByNode.clear()
    for (const a of this.db.anchors) {
      const arr = this.nodeAnchors.get(a.nodeId)
      if (arr) arr.push(a)
      else this.nodeAnchors.set(a.nodeId, [a])
      if (a.prevValue != null && a.prevValue !== a.newValue) {
        const st = this.stableAnchors.get(a.nodeId)
        if (st) st.push(a)
        else this.stableAnchors.set(a.nodeId, [a])
      }
    }
    for (const r of this.db.records) {
      if (r.status === 'open') this.openByNode.set(r.nodeId, r)
    }
  }

  /** 索引登记:新锚入账时增量维护,避免全量重建 */
  private indexAnchor(a: DcwJournalAnchor): void {
    const arr = this.nodeAnchors.get(a.nodeId)
    if (arr) arr.push(a)
    else this.nodeAnchors.set(a.nodeId, [a])
    if (a.prevValue != null && a.prevValue !== a.newValue) {
      const st = this.stableAnchors.get(a.nodeId)
      if (st) st.push(a)
      else this.stableAnchors.set(a.nodeId, [a])
    }
  }

  /** 环形淘汰后按 id 集合重建索引(仅在触发淘汰时发生,摊销成本 O(cap)) */
  private pruneIndexes(liveIds: Set<string>): void {
    for (const [nodeId, arr] of this.nodeAnchors) {
      const kept = arr.filter(a => liveIds.has(a.id))
      if (kept.length) this.nodeAnchors.set(nodeId, kept)
      else this.nodeAnchors.delete(nodeId)
    }
    for (const [nodeId, arr] of this.stableAnchors) {
      const kept = arr.filter(a => liveIds.has(a.id))
      if (kept.length) this.stableAnchors.set(nodeId, kept)
      else this.stableAnchors.delete(nodeId)
    }
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
    this.indexAnchor(anchor)
    if (this.db.anchors.length > ANCHORS_CAP) {
      const evicted = this.db.anchors.splice(0, this.db.anchors.length - ANCHORS_CAP)
      const live = new Set(this.db.anchors.map(x => x.id))
      // 仅当被淘汰的锚确实进了索引时才重建(避免每次追加都 O(cap))
      if (evicted.some(e => this.nodeAnchors.get(e.nodeId)?.some(x => x.id === e.id))) this.pruneIndexes(live)
    }
    this.flushDebounced()
    return anchor
  }

  /** 该节点最近一次锚(O(1):索引尾部) */
  lastAnchorOf(nodeId: string): DcwJournalAnchor | undefined {
    const arr = this.nodeAnchors.get(nodeId)
    return arr?.[arr.length - 1]
  }

  /** 该节点上一个「有效基线」锚:prevValue≠newValue 的最近一条(单步回退目标,O(1)) */
  lastStableAnchor(nodeId: string): DcwJournalAnchor | undefined {
    const arr = this.stableAnchors.get(nodeId)
    return arr?.[arr.length - 1]
  }

  anchorById(id: string): DcwJournalAnchor | undefined {
    return this.db.anchors.find(a => a.id === id)
  }

  /** 指定时刻之前该节点最近的稳定锚(批次级回退用)。
   *  只扫该节点的稳定锚子序列(通常远短于全量),并整体倒序短路。 */
  lastStableBefore(nodeId: string, atMs: number): DcwJournalAnchor | undefined {
    const arr = this.stableAnchors.get(nodeId)
    if (!arr) return undefined
    for (let i = arr.length - 1; i >= 0; i--) {
      const a = arr[i]!
      if (Date.parse(a.at) <= atMs)
        return a
    }
    return undefined
  }

  /** 倒序查询锚。按 nodeId 时走索引子序列(避免全量拷贝);limit 提前短路,不再先 reverse 整个数组。 */
  listAnchors(filter: { nodeId?: string, lineId?: string, source?: string, limit?: number }): DcwJournalAnchor[] {
    const limit = filter.limit ?? 100
    const out: DcwJournalAnchor[] = []
    // 走索引:候选集已按 nodeId 收窄,且天然时间正序 → 倒序遍历
    const source = filter.nodeId ? this.nodeAnchors.get(filter.nodeId) : this.db.anchors
    if (!source) return out
    for (let i = source.length - 1; i >= 0 && out.length < limit; i--) {
      const a = source[i]!
      if (filter.nodeId && a.nodeId !== filter.nodeId) continue
      if (filter.lineId && a.lineId !== filter.lineId) continue
      if (filter.source && a.source !== filter.source) continue
      out.push(a)
    }
    return out
  }

  /** 最近一次回退锚(冷却判断用)。只扫该节点子序列,命中即返回 —— 绝大多数情况 O(1)。 */
  lastRollbackAnchor(nodeId: string): DcwJournalAnchor | undefined {
    const arr = this.nodeAnchors.get(nodeId)
    if (!arr) return undefined
    for (let i = arr.length - 1; i >= 0; i--) {
      const a = arr[i]!
      if (a.source === 'rollback')
        return a
    }
    return undefined
  }

  // ---------- records(优化记录) ----------

  insertRecord(r: Omit<OptimizationRecord, 'id' | 'createdAt'> & { id?: string, createdAt?: string }): OptimizationRecord {
    const record: OptimizationRecord = { ...r, id: r.id ?? `opt-${randomUUID().slice(0, 8)}`, createdAt: r.createdAt ?? new Date().toISOString() }
    this.db.records.push(record)
    if (record.status === 'open') this.openByNode.set(record.nodeId, record)
    if (this.db.records.length > RECORDS_CAP) {
      const evicted = this.db.records.splice(0, this.db.records.length - RECORDS_CAP)
      // 淘汰的记录若仍是索引里的 open,需要让其自然失效(索引指向已不在册的对象)
      for (const e of evicted) {
        if (this.openByNode.get(e.nodeId) === e) this.openByNode.delete(e.nodeId)
      }
    }
    this.flushDebounced()
    return record
  }

  byId(id: string): OptimizationRecord | undefined {
    return this.db.records.find(r => r.id === id)
  }

  /** 该节点当前 open 记录(O(1):索引) */
  openRecordOf(nodeId: string): OptimizationRecord | undefined {
    const r = this.openByNode.get(nodeId)
    return r && r.status === 'open' ? r : undefined
  }

  /** 当前全部 open 记录(供 sweep 评估;避免每次全量 reverse+filter 2000 条) */
  listOpenRecords(): OptimizationRecord[] {
    const out: OptimizationRecord[] = []
    for (const r of this.openByNode.values()) {
      if (r.status === 'open') out.push(r)
    }
    return out
  }

  updateRecord(id: string, patch: Partial<OptimizationRecord>): OptimizationRecord | undefined {
    const r = this.byId(id)
    if (!r)
      return undefined
    const wasOpen = r.status === 'open'
    Object.assign(r, patch)
    // 维护 open 索引(状态可能 open→judged/rolled-back/superseded)
    if (r.status === 'open') this.openByNode.set(r.nodeId, r)
    else if (wasOpen && this.openByNode.get(r.nodeId) === r) this.openByNode.delete(r.nodeId)
    this.flushDebounced()
    return r
  }

  /** 倒序查询优化记录。单遍倒序 + limit 短路,替代「全量拷贝→reverse→逐条件 filter」的两次 O(n) 分配。 */
  listRecords(filter: { lineId?: string, recipeId?: string, nodeId?: string, status?: string, agentId?: string, limit?: number }): OptimizationRecord[] {
    const limit = filter.limit ?? 100
    const out: OptimizationRecord[] = []
    const src = this.db.records
    for (let i = src.length - 1; i >= 0 && out.length < limit; i--) {
      const r = src[i]!
      if (filter.lineId && r.lineId !== filter.lineId) continue
      if (filter.recipeId && r.recipeId !== filter.recipeId) continue
      if (filter.nodeId && r.nodeId !== filter.nodeId) continue
      if (filter.status && r.status !== filter.status) continue
      if (filter.agentId && r.agentId !== filter.agentId) continue
      out.push(r)
    }
    return out
  }

  /** 该节点的自动回退链长(防乒乓:链上已发生的回退记录数) */
  chainRollbackCount(nodeId: string): number {
    return this.db.records.filter(r => r.nodeId === nodeId && r.status === 'rolled-back').length
  }

  stats(): { anchors: number, records: number, open: number } {
    let open = 0
    for (const r of this.openByNode.values()) if (r.status === 'open') open++
    return { anchors: this.db.anchors.length, records: this.db.records.length, open }
  }
}

const g = globalThis as typeof globalThis & { __recipeRollBackRepo?: RecipeRollBackRepo }

export function getRecipeRollBackRepo(): RecipeRollBackRepo {
  g.__recipeRollBackRepo ??= new RecipeRollBackRepo()
  return g.__recipeRollBackRepo
}
