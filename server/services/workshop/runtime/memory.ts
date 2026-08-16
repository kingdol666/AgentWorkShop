/**
 * AgentMemory — AgentRuntime 的持久记忆模块(harness 无关)。
 * MemGPT 分层(长期记忆落库+预算召回)/ Mem0 harvest(complete_task 自产摘要零 LLM 成本)/
 * agent-memory 排序装配(0.5×相关性+0.3×时近性+0.2×重要性,贪心预算)。
 * 动态感知(2026-08-16):静态注入降级为小预算"引子"(recall;AW_MEMORY_PRIMER_TOKENS 默认 300),
 * 完整内容由 Agent 运行时经 search_memory 工具按需抓取(recallRows:scope 过滤+原文还原);
 * Agent 经 save_memory 主动沉淀并自动分流私有域/Channel 公共域(save)。
 * P1 注入 embedder 后 recall/recallRows 升级混合检索;P0 纯 FTS。全部方法 async(async 签名 P0 定型)。
 */
import { type MemoryRepo, TEAM_AGENT_ID } from '../db/memory.repo'
import { randomUUID } from 'node:crypto'
import type { MemoryRow } from '../db/database'
import type { WorkspaceTask } from '../types/task'
import type { A2AMessage, Part } from '../types/a2a'
import type { EmbeddingProvider } from './embedding-provider'

const W_RELEVANCE = 0.5
const W_RECENCY = 0.3
const W_IMPORTANCE = 0.2
const RECENCY_DAYS = 7
const RECENT_FALLBACK = 5
const WEAK_HIT_KEEP = 3
const MAX_TERMS = 12
const CONTENT_STORE_LIMIT = 800

/** 环境变量安全数值(非有限/非正数 → fallback;防 NaN/0 破坏预算与定时器) */
export function envNum(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export interface AgentMemoryOptions {
  channelId: string
  agentId: string
  /** 记忆引子(静态注入)预算覆盖;默认 AW_MEMORY_PRIMER_TOKENS(300)。完整内容经 search_memory 工具按需抓取 */
  budgetTokens?: number
  /** 注入后 recall 混合检索 + record* 自动向量化;未注入纯 FTS */
  embedder?: EmbeddingProvider
}

export interface RecallOptions {
  /** 默认 true;supervise 每 tick 调用应传 false 防 access_count 通胀 */
  touch?: boolean
  /** 本次召回预算覆盖(默认 AW_MEMORY_BUDGET_TOKENS) */
  budgetTokens?: number
  /** 检索域:auto=私有+公共(默认) / private=仅私有 / shared=仅 Channel 公共 */
  scope?: MemoryScope
}

export type MemoryScope = 'auto' | 'private' | 'shared'

/** 结构化记忆片段(工具按需抓取的返回体;content 已还原为未切分原文) */
export interface MemorySnippet {
  id: string
  kind: string
  title: string
  content: string
  importance: number
  createdAt: string
  /** 综合得分(0.5×相关性+0.3×时近性+0.2×重要性) */
  score: number
  source: 'private' | 'shared'
}

export function segmentCJK(text: string): string {
  return text.replace(/[\u4e00-\u9fff]+/g, run => ` ${run.split('').join(' ')} `)
}

export function buildMatchQuery(text: string): string | null {
  const cleaned = text.replace(/["'*().:+-]/g, ' ').toLowerCase()
  const terms = segmentCJK(cleaned)
    .split(/\s+/)
    .filter(Boolean)
    .filter(t => /[\u4e00-\u9fff]/.test(t) || t.length >= 2)
    .filter(t => !['and', 'or', 'not', 'near'].includes(t))
    .slice(0, MAX_TERMS)
  // 词项一律引号包裹:残留特殊字符(FTS5 列过滤/短语语法)全部惰性化
  return terms.length > 0 ? terms.map(t => `"${t}"`).join(' OR ') : null
}

export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  return Math.ceil((text.length - cjk) / 4) + cjk
}

/** 切分还原(segmentCJK 的逆变换;工具返回/注入展示用可读原文)。
 *  ascii↔CJK 边界的多空格收敛为单空格(segmentCJK 会给 CJK run 两侧补空格,
 *  与原文空格叠加成双空格;无法区分原意,统一收敛)。 */
export function unsegmentCJK(text: string): string {
  return text
    .replace(/(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '')
    .replace(/(?<=[\u4e00-\u9fff])\s+([,.;:!?，。；：！？])/g, '$1')
    .replace(/([,.;:!?，。；：！？])\s+(?=[\u4e00-\u9fff])/g, '$1')
    .replace(/([A-Za-z0-9])\s+(?=[\u4e00-\u9fff])/g, '$1 ')
    .replace(/(?<=[\u4e00-\u9fff])\s+(?=[A-Za-z0-9])/g, ' ')
    .trim()
}

function partsText(parts: Part[]): string {
  return parts.map(p => ('text' in p ? p.text : '')).filter(Boolean).join('\n')
}

function humanAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (Number.isNaN(ms)) return '?'
  if (ms < 60_000) return '刚刚'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}分钟前`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}小时前`
  return `${Math.floor(ms / 86_400_000)}天前`
}

export class AgentMemory {
  private embedder: EmbeddingProvider | null

  constructor(
    private repo: MemoryRepo,
    private opts: AgentMemoryOptions,
  ) {
    this.embedder = opts.embedder ?? null
  }

  /** 向量层惰性初始化(vecReady 后 no-op;建表失败一次性禁用 embedder) */
  private ensureVec(): void {
    if (this.repo.vecReady) return
    const dims = this.embedder?.dims()
    if (dims && !this.repo.vecInit(dims)) this.embedder = null
  }

  /** scope 过滤:private 仅本人行;shared 仅本 channel 的 team 行;auto 双域 */
  private inScope(row: MemoryRow, scope: MemoryScope): boolean {
    const isTeam = row.agentId === TEAM_AGENT_ID
    if (isTeam && row.channelId !== this.opts.channelId) return false
    return scope === 'auto'
      ? (isTeam || row.agentId === this.opts.agentId)
      : scope === 'shared'
        ? isTeam
        : row.agentId === this.opts.agentId
  }

  /** 混合检索原始命中(FTS+向量融合;不排序不 touch) */
  private async collectHits(query: string, scope: MemoryScope): Promise<Map<string, { row: MemoryRow, relevance: number }>> {
    const hits = new Map<string, { row: MemoryRow, relevance: number }>()
    const match = buildMatchQuery(query)
    if (match) {
      const found = this.repo.search(this.opts.agentId, match, MAX_TERMS)
      const first = found[0]
      const best = first ? Math.max(-first.bm25, 0.001) : 1
      // 弱命中保留按"过滤后保留数"计数(非原始下标):
      // 跨 channel 的 team 残留行会占据排序下标,若按下标保留会把本 channel 有效弱命中挤出门外
      let kept = 0
      for (const row of found) {
        if (!this.inScope(row, scope)) continue
        const rel = Math.min(1, -row.bm25 / best)
        if (rel >= 0.1 || kept < WEAK_HIT_KEEP) {
          hits.set(row.id, { row, relevance: rel })
          kept += 1
        }
      }
    }
    // 向量分支:查询向量 + 本人/team 双域 kNN,与 FTS 按 id 融合(rel 取 max;失败退化纯 FTS)
    if (this.embedder) {
      try {
        const [qv] = await this.embedder.embed([query])
        if (qv) {
          this.ensureVec()
          const ownDomains: string[]
            = scope === 'shared'
              ? [TEAM_AGENT_ID]
              : scope === 'private'
                ? [this.opts.agentId]
                : [this.opts.agentId, TEAM_AGENT_ID]
          const vAll = ownDomains.flatMap(d =>
            this.repo.vecSearch(d, qv, d === TEAM_AGENT_ID ? 5 : 10))
          // rowid → 最小距离(agent/team 分区不相交;防御性取 min)
          const distByRowid = new Map<number, number>()
          for (const { memRowid, distance } of vAll) {
            const prev = distByRowid.get(memRowid)
            if (prev === undefined || distance < prev) distByRowid.set(memRowid, distance)
          }
          for (const row of this.repo.listByRowids([...distByRowid.keys()])) {
            // 所有权守卫 + channel 隔离 + scope 过滤(脏 rowid/rowid 复用反查到他人行一律丢弃)
            if (!this.inScope(row, scope)) continue
            if (row.agentId !== this.opts.agentId && row.agentId !== TEAM_AGENT_ID) continue
            const sim = Math.min(1, Math.max(0, 1 - (distByRowid.get(row.rowid) ?? 1)))
            const prev = hits.get(row.id)
            hits.set(row.id, { row, relevance: prev ? Math.max(prev.relevance, sim) : sim })
          }
        }
      }
      catch { /* 向量不可用退化为 FTS */ }
    }
    // 时近兜底仅对含私有域的 scope 生效(shared 域无"本人最近"语义)
    if (scope !== 'shared') {
      for (const row of this.repo.listRecent(this.opts.agentId, RECENT_FALLBACK)) {
        if (!hits.has(row.id)) hits.set(row.id, { row, relevance: 0.15 })
      }
    }
    return hits
  }

  /** 排序(综合分降序;不含预算/touch 副作用) */
  private async rank(query: string, scope: MemoryScope): Promise<Array<{ row: MemoryRow, relevance: number, score: number }>> {
    const hits = await this.collectHits(query, scope)
    return [...hits.values()]
      .map(h => ({ ...h, score: this.score(h.row, h.relevance) }))
      .sort((a, b) => b.score - a.score)
  }

  /**
   * run/supervise 前的"记忆引子"注入:混合检索+排序+小预算装配 → 记忆块。
   * 默认 AW_MEMORY_PRIMER_TOKENS(300)小预算,只给最相关的少量线索;
   * 完整内容由 Agent 运行时经 search_memory 工具按需抓取(防全量注入污染上下文)。
   */
  async recall(query: string, recallOpts: RecallOptions = {}): Promise<string | null> {
    const doTouch = recallOpts.touch !== false
    const budget = recallOpts.budgetTokens ?? this.opts.budgetTokens ?? envNum('AW_MEMORY_PRIMER_TOKENS', 300)
    const scope = recallOpts.scope ?? 'auto'
    const scored = await this.rank(query, scope)
    if (scored.length === 0) return null

    const lines: string[] = []
    const touched: string[] = []
    let used = 0
    for (const s of scored) {
      const line = this.formatLine(s.row)
      const cost = estimateTokens(line)
      if (used + cost > budget) continue
      used += cost
      lines.push(line)
      if (doTouch) touched.push(s.row.id)
    }
    if (lines.length === 0) return null
    for (const id of touched) this.repo.touch(id)
    return [
      `## 相关记忆(自动召回的高相关/最近线索摘要;与当前任务冲突时,以当前任务为准)`,
      ...lines,
      `以上仅为摘要线索;完整细节与更多历史记忆可用 search_memory 工具按需检索(支持 private/shared 域过滤)。`,
    ].join('\n')
  }

  /**
   * 工具按需抓取(search_memory):结构化片段返回,content 还原为未切分原文。
   * 触发 touch(access_count 强化后续召回排序);limit 上限防御。
   */
  async recallRows(query: string, opts: { scope?: MemoryScope, limit?: number } = {}): Promise<MemorySnippet[]> {
    const scope = opts.scope ?? 'auto'
    const limit = Math.min(Math.max(opts.limit ?? 5, 1), 20)
    const scored = (await this.rank(query, scope)).slice(0, limit)
    for (const s of scored) this.repo.touch(s.row.id)
    return scored.map(s => ({
      id: s.row.id,
      kind: s.row.kind,
      title: s.row.title,
      content: unsegmentCJK(s.row.content).slice(0, 500),
      importance: s.row.importance,
      createdAt: s.row.createdAt,
      score: Math.round(s.score * 1000) / 1000,
      source: s.row.agentId === TEAM_AGENT_ID ? 'shared' : 'private',
    }))
  }

  /**
   * Agent 主动沉淀(save_memory 工具):把作业过程中的可复用结论/经验写入记忆库。
   * scope='private' → 本人 semantic 域;scope='shared' → Channel 公共域(全员可检索;
   * dedupKey 按来源 Agent 命名空间隔离,避免多 Agent 同 key 互相覆盖)。写入后自动向量化。
   */
  async save(input: { title: string, content: string, importance?: number, scope: 'private' | 'shared', dedupKey?: string }): Promise<{ scope: 'private' | 'shared', dedupKey: string }> {
    const shared = input.scope === 'shared'
    const rawKey = input.dedupKey?.trim() || `agent-save:${randomUUID().slice(0, 8)}`
    // 共享域命名空间:同 channel 多 agent 各自的沉淀互不覆盖
    const dedupKey = shared ? `agent:${this.opts.agentId}:${rawKey}` : rawKey
    const owner = shared ? TEAM_AGENT_ID : this.opts.agentId
    this.repo.upsert({
      channelId: this.opts.channelId,
      agentId: owner,
      kind: 'semantic',
      title: input.title,
      titleFts: segmentCJK(input.title),
      content: segmentCJK(input.content).slice(0, CONTENT_STORE_LIMIT),
      importance: input.importance ?? (shared ? 0.85 : 0.7),
      taskId: null,
      dedupKey,
    })
    await vectorizeMemory(this.repo, this.embedder, this.opts.channelId, owner, dedupKey, input.content)
    return { scope: input.scope, dedupKey }
  }

  /** run 后(任务路径;仅终态调用):harvest TaskEngine 终态 + deliverable */
  async recordTaskOutcome(task: WorkspaceTask): Promise<void> {
    // 优先 deliverable/summary 命名成果;harness 任意命名(如 mock 的 result)兜底取全部成果
    const preferred = task.artifacts.filter(a => a.name === 'deliverable' || a.name === 'summary')
    const source = preferred.length > 0 ? preferred : task.artifacts
    const deliverable = source
      .flatMap(a => a.parts)
      .map(p => ('text' in p ? p.text : ''))
      .join(' ')
      .trim()
    const content = deliverable || task.description || task.title
    this.repo.upsert({
      channelId: this.opts.channelId,
      agentId: this.opts.agentId,
      kind: 'episodic-task',
      title: task.title,
      titleFts: segmentCJK(task.title),
      content: segmentCJK(content).slice(0, CONTENT_STORE_LIMIT),
      importance: task.state === 'COMPLETED' ? 0.8 : 0.55,
      taskId: task.id,
      dedupKey: `task:${task.id}`,
    })
    await this.vectorize(content, `task:${task.id}`)
  }

  /** run 后(点对点路径):请求 + 我方回复摘要 */
  async recordPeerExchange(msg: A2AMessage, replyText: string): Promise<void> {
    const ask = partsText(msg.parts).slice(0, 150)
    const content = replyText ? `问:${ask} 答:${replyText.slice(0, 250)}` : ask
    const fromId = (msg.metadata?.['x-aw-from-agent'] as string | undefined) ?? 'unknown'
    const title = `来自 ${fromId} 的消息`
    this.repo.upsert({
      channelId: this.opts.channelId,
      agentId: this.opts.agentId,
      kind: 'episodic-peer',
      title,
      titleFts: segmentCJK(title),
      content: segmentCJK(content).slice(0, 600),
      importance: 0.4,
      taskId: msg.taskId ?? null,
      dedupKey: `peer:${msg.messageId}`,
    })
    await this.vectorize(content, `peer:${msg.messageId}`)
  }

  /** 写入后向量化(委托模块级 vectorizeMemory;未切分原文,失败静默留 FTS) */
  private async vectorize(plainContent: string, dedupKey: string): Promise<void> {
    await vectorizeMemory(this.repo, this.embedder, this.opts.channelId, this.opts.agentId, dedupKey, plainContent)
  }

  private score(row: MemoryRow, relevance: number): number {
    const ageDays = (Date.now() - Date.parse(row.createdAt)) / 86_400_000
    const recency = Math.exp(-ageDays / RECENCY_DAYS)
    const importance = Math.min(1, row.importance + row.accessCount * 0.05)
    return W_RELEVANCE * relevance + W_RECENCY * recency + W_IMPORTANCE * importance
  }

  private formatLine(row: MemoryRow): string {
    const tag = row.kind === 'episodic-task'
      ? '任务'
      : row.kind === 'episodic-peer'
        ? '协作'
        : '共享'
    const content = unsegmentCJK(row.content)
    const short = content.length > 240 ? `${content.slice(0, 240)}…` : content
    return `- [${humanAgo(row.createdAt)}·${tag}] ${row.title}:${short}`
  }
}

/** 写入后向量化(模块级;任务路径经 AgentMemory.vectorize,策展路径由 manager 直调)。
 *  ensure-vec → 定位行(dedupKey)→ embed(未切分原文,语义质量优先)→ vecSet;失败静默留 FTS。 */
export async function vectorizeMemory(
  repo: MemoryRepo,
  embedder: EmbeddingProvider | null,
  channelId: string,
  agentId: string,
  dedupKey: string,
  plainContent: string,
): Promise<void> {
  if (!embedder) return
  try {
    const [vec] = await embedder.embed([plainContent])
    if (!vec) return
    const dims = embedder.dims()
    if (dims && !repo.vecInit(dims)) return // 维度冲突:一次性放弃本次写入(留 FTS)
    const at = repo.findByAgentDedup(channelId, agentId, dedupKey)
    if (at) repo.vecSet(at.rowid, agentId, vec)
  }
  catch { /* 向量化失败留 FTS */ }
}

// ===== 衰减清理(文件级维护函数;定时器/REST 共用)=====

export interface MaintenanceResult {
  deletedExpired: number
  evicted: number
  cleanedVec: number
}

/**
 * 记忆维护:① episodic 过期删除(now - (lastAccessedAt ?? createdAt) > expireDays)
 * ② 每 agent 容量淘汰(仅 episodic;effectiveScore = importance + accessCount×0.05 降序保留)
 * ③ 孤儿 vec 清理。semantic 与 team 哨兵行(人工策展)全程豁免。
 */
export function runMemoryMaintenance(
  repo: MemoryRepo,
  opts: { expireDays?: number, cap?: number } = {},
): MaintenanceResult {
  const expireDays = opts.expireDays ?? envNum('AW_MEMORY_EXPIRE_DAYS', 180)
  const cap = opts.cap ?? envNum('AW_MEMORY_CAP', 500)
  const expireMs = expireDays * 86_400_000
  const now = Date.now()
  let deletedExpired = 0
  let evicted = 0

  for (const agentId of repo.listMemoryAgentIds()) {
    if (agentId === TEAM_AGENT_ID) continue // 双保险:team 行人工策展,永不衰减
    const rows = repo.listByAgentWithRowid(agentId, 1_000_000)
    // ① 过期删除(仅 episodic)
    for (const r of rows) {
      if (!r.kind.startsWith('episodic')) continue
      if (now - Date.parse(r.lastAccessedAt ?? r.createdAt) > expireMs) {
        repo.vecDelete(r.rowid)
        repo.delete(r.id)
        deletedExpired++
      }
    }
    // ② 容量淘汰(仅 episodic;vec 已在上面过期路径删,此处剩余重查)
    const remaining = repo.listByAgentWithRowid(agentId, 1_000_000)
      .filter(r => r.kind.startsWith('episodic'))
    if (remaining.length > cap) {
      const sorted = remaining
        .map(r => ({ r, s: r.importance + r.accessCount * 0.05 }))
        .sort((a, b) => b.s - a.s)
      for (const { r } of sorted.slice(cap)) {
        repo.vecDelete(r.rowid)
        repo.delete(r.id)
        evicted++
      }
    }
  }
  let cleanedVec = 0
  try {
    cleanedVec = repo.vecCleanOrphans()
  }
  catch { /* vec 未启用 */ }
  return { deletedExpired, evicted, cleanedVec }
}
