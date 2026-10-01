/**
 * ExpStateRepo —— 产线 Co-Pilot 经验采集状态仓(exp-state.json,json-store)。
 *
 * 承载学习循环的四类状态(产线 Co-Pilot 计划 §5.1):
 *  - lines[lineId].watermark  两阶段读取水位(at + 已见锚 id 集 + 审计 id;锚 id 非 UUID 单调,
 *                             锚账本 cap 头部淘汰 → 水位必须双字段,见计划 §2.1)
 *  - lines[lineId].snapshot   上轮 dcw 读回快照(节点 → SET;轮间 diff 检测"平台无锚的本地调整")
 *  - lines[lineId].paramMeta  参数语义位(sp|pv;冷启动按模板 key 推断,允许人工改标)
 *  - episodes                 经验动作 episode(cap 500 FIFO;pending → summarized → done 两阶段,
 *                             KB 入库确认后才 done;哈希去重,collect 崩溃下轮重采不重记)
 *  - confirmations            推断动作待确认队列(cap 200;人工确认后才转 episode 进入总结 —— 铁律 9)
 *  - registry                 经验注册表(line+node+问题类型 → 最新版本指针:版本化标题+置信度+task_ids;
 *                             对账靠 kb_agent sync 检索 best-effort,计划 §2.3)
 *
 * 与 recipe-rollback.repo 同构(loadJsonFile/saveJsonFileAtomic + 单例);采集为 6h 级低频,
 * 每次变更同步原子落盘(不走防抖 —— 量小,且水位丢失会导致重复采集)。
 */
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ensureDataDir } from '@/shared/config/home.mjs'
import { loadJsonFile, saveJsonFileAtomic } from '../json-store.mjs'

// 配置根 .AgentWorkShop/data(ensureDataDir 自动迁移旧 cwd/server/data 位置)
const DEFAULT_PATH = join(ensureDataDir(), 'exp-state.json')

const EPISODES_CAP = 500
const CONFIRMATIONS_CAP = 200
/** 已见锚 id 集合上限(保新剔旧;500 条 episode 窗口 × 平均簇大小,绰绰有余) */
const SEEN_IDS_CAP = 1000

/** episode 状态:pending(采集落账)→ summarized(LLM 总结完成)→ done(KB 入库确认) */
export type ExpEpisodeStatus = 'pending' | 'summarized' | 'done'

/** 经验动作(平台动作=锚账本增量;推断动作=快照 diff 经人工确认转正) */
export interface ExpEpisode {
  id: string
  lineId: string
  nodeIds: string[]
  kind: 'platform' | 'inferred'
  source: 'manual' | 'agent' | 'recipe' | 'inferred'
  actor: string
  actorKind: 'user' | 'agent' | 'system'
  params: Array<{ nodeId: string, from: number | null, to: number, unit?: string }>
  at: string
  /** 证据锚 id 集(锚账本;推断动作为空) */
  anchors: string[]
  /** 交叉到的 audit_log 行 id 集(归因佐证) */
  auditIds: string[]
  /** 已附人类意见(approval_history comment / 推断依据) */
  comments: string[]
  status: ExpEpisodeStatus
  /** 语义哈希(去重键;collect 重试/重复采集不重记) */
  hash: string
}

/** 推断动作待确认卡片(确认队列;产线可写者可裁决) */
export interface ExpConfirmation {
  id: string
  lineId: string
  nodeId: string
  nodeName: string
  from: number | null
  to: number
  at: string
  evidence: string
  status: 'pending' | 'confirmed' | 'ignored'
  decidedBy: string
  decidedAt: string | null
}

/** 经验注册表条目(版本化标题指针 + 置信度 + kb task id 轨迹) */
export interface ExpRegistryEntry {
  title: string
  version: number
  confidence: '观察' | '候选' | '稳'
  lastAt: string
  taskIds: string[]
}

/** 两阶段读取水位 */
export interface ExpWatermark {
  /** 已消费锚的最大 at(epoch ms;锚按 at 过滤的粗水位) */
  lastAnchorAt: number
  /** 已见锚 id 集(UUID 非单调,同 ms 锚靠它剔重) */
  seenAnchorIds: string[]
  /** 已见 audit_log 最大行 id(留档,为将来审计侧增量留口) */
  lastAuditId: number
}

export interface ExpNodeSnapshot { set: number, readAt: number }

export interface ExpLineState {
  watermark: ExpWatermark
  snapshot: Record<string, ExpNodeSnapshot>
  paramMeta: Record<string, { semantic: 'sp' | 'pv' }>
}

export interface ExpStateDb {
  lines: Record<string, ExpLineState>
  episodes: ExpEpisode[]
  confirmations: ExpConfirmation[]
  registry: Record<string, ExpRegistryEntry>
}

function emptyDb(): ExpStateDb {
  return { lines: {}, episodes: [], confirmations: [], registry: {} }
}

/**
 * episode 语义哈希(去重键):lineId+kind+source+params+at+锚 id 集。
 * 与展示性字段(actor/auditIds/comments)无关 —— 归因增强不产生新 episode。
 */
export function episodeHashOf(e: Pick<ExpEpisode, 'lineId' | 'kind' | 'source' | 'params' | 'at' | 'anchors'>): string {
  const canonical = JSON.stringify({
    lineId: e.lineId,
    kind: e.kind,
    source: e.source,
    params: [...e.params].sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
    at: e.at,
    anchors: [...e.anchors].sort(),
  })
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

function lineStateOf(db: ExpStateDb, lineId: string): ExpLineState {
  db.lines[lineId] ??= { watermark: { lastAnchorAt: 0, seenAnchorIds: [], lastAuditId: 0 }, snapshot: {}, paramMeta: {} }
  return db.lines[lineId]!
}

export class ExpStateRepo {
  readonly filePath: string
  private db: ExpStateDb

  // 构造注入路径(单测用临时目录);显式赋值而非字段初始化器 —— 原生 class fields
  // 语义下字段初始化先于构造体执行,读不到参数属性
  constructor(filePath: string = DEFAULT_PATH) {
    this.filePath = filePath
    this.db = loadDb(filePath)
  }

  private flush(): void {
    try {
      saveJsonFileAtomic(this.filePath, this.db)
    }
    catch (err) {
      console.error('[exp-state] 落盘失败:', err)
    }
  }

  /** 全量状态(只读面;调用方不得改写内部对象) */
  getState(): ExpStateDb {
    return this.db
  }

  // ---------- episodes(两阶段:采集落账 pending → 总结 summarized → 入库 done) ----------

  /**
   * 记录 episode(按 hash 去重,补 id/status/hash),cap 500 FIFO 淘汰。
   * 返回本轮真正新增的 episode(与去重后的入账集一致)。
   */
  recordEpisodes(lineId: string, drafts: Array<Omit<ExpEpisode, 'id' | 'lineId' | 'status' | 'hash'>>): ExpEpisode[] {
    const known = new Set(this.db.episodes.map(e => e.hash))
    const added: ExpEpisode[] = []
    for (const d of drafts) {
      const hash = episodeHashOf({ lineId, kind: d.kind, source: d.source, params: d.params, at: d.at, anchors: d.anchors })
      if (known.has(hash)) continue
      known.add(hash)
      // 显式构造:草稿上的内部字段(如聚合用的 untilAt)不透传入库
      const full: ExpEpisode = {
        id: `exp-${randomUUID().slice(0, 8)}`,
        lineId,
        nodeIds: [...d.nodeIds],
        kind: d.kind,
        source: d.source,
        actor: d.actor,
        actorKind: d.actorKind,
        params: d.params.map(p => (p.unit != null ? { ...p } : { nodeId: p.nodeId, from: p.from, to: p.to })),
        at: d.at,
        anchors: [...d.anchors],
        auditIds: [...d.auditIds],
        comments: [...d.comments],
        status: 'pending',
        hash,
      }
      added.push(full)
      this.db.episodes.push(full)
    }
    if (added.length > 0) {
      if (this.db.episodes.length > EPISODES_CAP)
        this.db.episodes.splice(0, this.db.episodes.length - EPISODES_CAP)
      this.flush()
    }
    return added
  }

  /** 状态推进(pending→summarized→done;目标不存在返回 undefined) */
  markEpisode(id: string, status: ExpEpisodeStatus): ExpEpisode | undefined {
    const e = this.db.episodes.find(x => x.id === id)
    if (!e) return undefined
    e.status = status
    this.flush()
    return e
  }

  listEpisodes(filter: { lineId?: string, status?: ExpEpisodeStatus, kind?: 'platform' | 'inferred', limit?: number } = {}): ExpEpisode[] {
    const out = this.db.episodes.filter((e) => {
      if (filter.lineId && e.lineId !== filter.lineId) return false
      if (filter.status && e.status !== filter.status) return false
      if (filter.kind && e.kind !== filter.kind) return false
      return true
    })
    return filter.limit != null ? out.slice(-filter.limit) : out
  }

  // ---------- confirmations(推断动作待确认队列) ----------

  /**
   * 入队推断动作确认卡;同 (lineId,nodeId,from,to) 的 pending 卡幂等去重。
   * cap 200 FIFO;返回 { confirmation, added }。
   */
  addConfirmation(c: Omit<ExpConfirmation, 'id' | 'status' | 'decidedBy' | 'decidedAt'>): { confirmation: ExpConfirmation, added: boolean } {
    const dup = this.db.confirmations.find(x =>
      x.status === 'pending' && x.lineId === c.lineId && x.nodeId === c.nodeId
      && x.from === c.from && x.to === c.to,
    )
    if (dup) return { confirmation: dup, added: false }
    const card: ExpConfirmation = {
      ...c,
      id: `cfm-${randomUUID().slice(0, 8)}`,
      status: 'pending',
      decidedBy: '',
      decidedAt: null,
    }
    this.db.confirmations.push(card)
    if (this.db.confirmations.length > CONFIRMATIONS_CAP)
      this.db.confirmations.splice(0, this.db.confirmations.length - CONFIRMATIONS_CAP)
    this.flush()
    return { confirmation: card, added: true }
  }

  listConfirmations(filter: { lineId?: string, status?: ExpConfirmation['status'] } = {}): ExpConfirmation[] {
    return this.db.confirmations.filter((c) => {
      if (filter.lineId && c.lineId !== filter.lineId) return false
      if (filter.status && c.status !== filter.status) return false
      return true
    })
  }

  /**
   * 裁决确认卡(ok=true 确认转正 / false 忽略);确认时把该推断转成 episode
   * (kind=inferred, status=pending)入队 —— 铁律 9:未经人工确认不得进入总结。
   * 目标不存在返回 undefined。
   */
  decideConfirmation(id: string, ok: boolean, by: string): { confirmation: ExpConfirmation, episode?: ExpEpisode } | undefined {
    const c = this.db.confirmations.find(x => x.id === id)
    if (!c) return undefined
    c.status = ok ? 'confirmed' : 'ignored'
    c.decidedBy = by
    c.decidedAt = new Date().toISOString()
    let episode: ExpEpisode | undefined
    if (ok) {
      const [added] = this.recordEpisodes(c.lineId, [{
        nodeIds: [c.nodeId],
        kind: 'inferred',
        source: 'inferred',
        actor: by,
        actorKind: 'user',
        params: [{ nodeId: c.nodeId, from: c.from, to: c.to }],
        at: c.at,
        anchors: [],
        auditIds: [],
        comments: [`推断依据:${c.evidence}`],
      }])
      episode = added
    }
    this.flush()
    return { confirmation: c, episode }
  }

  // ---------- 产线级状态(水位 / 快照 / 语义位) ----------

  getWatermark(lineId: string): ExpWatermark {
    return lineStateOf(this.db, lineId).watermark
  }

  setWatermark(lineId: string, wm: ExpWatermark): void {
    const ls = lineStateOf(this.db, lineId)
    ls.watermark = { ...wm, seenAnchorIds: wm.seenAnchorIds.slice(-SEEN_IDS_CAP) }
    this.flush()
  }

  /** 上轮 dcw 读回快照(未建立返回 undefined —— 采集首轮只建快照不推断) */
  getSnapshot(lineId: string): Record<string, ExpNodeSnapshot> | undefined {
    const ls = this.db.lines[lineId]
    return ls && Object.keys(ls.snapshot).length > 0 ? ls.snapshot : undefined
  }

  setSnapshot(lineId: string, snapshot: Record<string, ExpNodeSnapshot>): void {
    lineStateOf(this.db, lineId).snapshot = snapshot
    this.flush()
  }

  paramMetaGet(lineId: string, nodeId: string): { semantic: 'sp' | 'pv' } | undefined {
    return this.db.lines[lineId]?.paramMeta[nodeId]
  }

  paramMetaSet(lineId: string, nodeId: string, semantic: 'sp' | 'pv'): void {
    lineStateOf(this.db, lineId).paramMeta[nodeId] = { semantic }
    this.flush()
  }

  // ---------- 经验注册表 ----------

  registryGet(key: string): ExpRegistryEntry | undefined {
    return this.db.registry[key]
  }

  registrySet(key: string, entry: ExpRegistryEntry): void {
    this.db.registry[key] = entry
    this.flush()
  }
}

function loadDb(filePath: string): ExpStateDb {
  const parsed = loadJsonFile(filePath, emptyDb()) as Partial<ExpStateDb>
  return {
    lines: parsed.lines ?? {},
    episodes: parsed.episodes ?? [],
    confirmations: parsed.confirmations ?? [],
    registry: parsed.registry ?? {},
  }
}

const g = globalThis as typeof globalThis & { __expStateRepo?: ExpStateRepo }

export function getExpStateRepo(): ExpStateRepo {
  g.__expStateRepo ??= new ExpStateRepo()
  return g.__expStateRepo
}
