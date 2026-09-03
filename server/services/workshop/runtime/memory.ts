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
const RECENT_FALLBACK = 5
const MAX_TERMS = 12
/** CJK 单字词项上限(单字区分度低,12 个易主题漂移;ascii 词项仍取 MAX_TERMS) */
const MAX_CJK_TERMS = 24
/** FTS 候选池深度(RRF 融合需要比最终引子更深的榜) */
const FTS_POOL = 20
/** Reciprocal Rank Fusion 常数(业界标准 k=60) */
const RRF_K = 60
/** MMR 多样性权重(λ×相关性 − (1−λ)×与已选集的最大相似) */
const MMR_LAMBDA = 0.7
/** 任务关联加权:候选行 taskId ∈ 兄弟/父任务集时终分加成 */
const RELATED_TASK_BOOST = 0.3
/** 策展层 kind(确定性 L0/按 key 直取;不进 L1 排名防双份注入,search_memory 仍可命中) */
const CURATED_KINDS = new Set(['brief', 'chronicle', 'reflection'])
/** kind 感知时近衰减半衰期(天;0 = 不衰减) */
const RECENCY_HALF_LIFE_DAYS: Record<string, number> = {
  'episodic-peer': 3,
  'episodic-task': 14,
  'episodic-session': 14,
  'episodic-team-task': 14,
  'semantic': 0,
  'brief': 0,
  'chronicle': 0,
  'reflection': 0,
}
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
  /** 任务关联集(自身+父+兄弟 ≤20):命中行终分 +RELATED_TASK_BOOST(任务需求驱动的相关性) */
  relatedTaskIds?: string[]
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
  const words = segmentCJK(cleaned).split(/\s+/).filter(Boolean)
  const cjkTerms: string[] = []
  const otherTerms: string[] = []
  for (const t of words) {
    const isCjk = /[\u4e00-\u9fff]/.test(t)
    if (!isCjk && (t.length < 2 || ['and', 'or', 'not', 'near'].includes(t))) continue
    const pool = isCjk ? cjkTerms : otherTerms
    const cap = isCjk ? MAX_CJK_TERMS : MAX_TERMS
    if (pool.length >= cap) continue
    if (!pool.includes(t)) pool.push(t)
  }
  const terms = [...otherTerms, ...cjkTerms]
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

  /**
   * 混合检索原始命中(RRF 融合;不排序不 touch)。
   * FTS 榜与向量榜各按名次贡献 1/(k+rank) 累加,再按榜内最高分归一化到 0-1——
   * 相比 v1 的 max 距离归一化,弱首命中/两榜分纲不一致时排序依然稳定。
   */
  private async collectHits(query: string, scope: MemoryScope): Promise<Map<string, { row: MemoryRow, relevance: number }>> {
    const rrf = new Map<string, { row: MemoryRow, score: number }>()
    const addRank = (row: MemoryRow, rank: number): void => {
      if (!this.inScope(row, scope)) return
      const inc = 1 / (RRF_K + rank + 1)
      const cur = rrf.get(row.id)
      if (cur) cur.score += inc
      else rrf.set(row.id, { row, score: inc })
    }
    const match = buildMatchQuery(query)
    if (match) {
      const found = this.repo.search(this.opts.agentId, match, FTS_POOL)
      found.forEach((row, i) => addRank(row, i))
    }
    // 向量分支:查询向量 + 本人/team 双域 kNN,按距离名次参与 RRF(失败退化纯 FTS)
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
          // rowid → 最小距离(agent/team 分区不相交;防御性取 min),保持距离序作名次
          const distByRowid = new Map<number, number>()
          for (const { memRowid, distance } of vAll) {
            const prev = distByRowid.get(memRowid)
            if (prev === undefined || distance < prev) distByRowid.set(memRowid, distance)
          }
          const rowids = [...distByRowid.entries()].sort((a, b) => a[1] - b[1]).map(([rid]) => rid)
          this.repo.listByRowids(rowids).forEach((row, i) => {
            // 所有权守卫 + channel 隔离(脏 rowid/rowid 复用反查到他人行一律丢弃)
            if (row.agentId !== this.opts.agentId && row.agentId !== TEAM_AGENT_ID) return
            addRank(row, i)
          })
        }
      }
      catch { /* 向量不可用退化为 FTS */ }
    }
    // 时近兜底仅对含私有域的 scope 生效(shared 域无"本人最近"语义);
    // 兜底行不参与 RRF,固定弱相关度(策展层行排除——brief 恒 L0 注入,不占引子)
    const hits = new Map<string, { row: MemoryRow, relevance: number }>()
    let best = 0
    for (const { score } of rrf.values()) {
      if (score > best) best = score
    }
    for (const { row, score } of rrf.values()) {
      hits.set(row.id, { row, relevance: best > 0 ? score / best : 0 })
    }
    if (scope !== 'shared') {
      for (const row of this.repo.listRecent(this.opts.agentId, RECENT_FALLBACK)) {
        if (CURATED_KINDS.has(row.kind)) continue
        if (!hits.has(row.id)) hits.set(row.id, { row, relevance: 0.15 })
      }
    }
    return hits
  }

  /** 排序(综合分降序;策展层排除/任务关联加权;不含预算/touch 副作用) */
  private async rank(
    query: string,
    scope: MemoryScope,
    opts: { excludeCurated?: boolean, relatedTaskIds?: string[] } = {},
  ): Promise<Array<{ row: MemoryRow, relevance: number, score: number }>> {
    const hits = await this.collectHits(query, scope)
    const related = opts.relatedTaskIds && opts.relatedTaskIds.length > 0 ? new Set(opts.relatedTaskIds) : null
    return [...hits.values()]
      .filter(h => !opts.excludeCurated || !CURATED_KINDS.has(h.row.kind))
      .map((h) => {
        let score = this.score(h.row, h.relevance)
        if (related && h.row.taskId && related.has(h.row.taskId)) {
          score = Math.min(1, score + RELATED_TASK_BOOST)
        }
        return { ...h, score }
      })
      .sort((a, b) => b.score - a.score)
  }

  /**
   * run/supervise 前的记忆注入:三层装配(硬顶 AW_MEMORY_INJECT_TOTAL)。
   *  - L0 会话简报(brief 行,确定性置顶,不占检索);
   *  - L1 相关性引子(RRF 混合检索 + MMR 多样性 + 任务关联加权,小预算);
   *  - 完整内容由 Agent 经 search_memory 工具按需抓取(L2)。
   * 预算内装配;使用提示计费(防提示挤占正文预算)。
   */
  async recall(query: string, recallOpts: RecallOptions = {}): Promise<string | null> {
    const doTouch = recallOpts.touch !== false
    // 显式 budgetTokens(实例/调用级)= 整块记忆硬顶(L0 简报+L1 引子+提示全计入);
    // 未显式设置 = 双预算:L1 引子 ≤ AW_MEMORY_PRIMER_TOKENS(300),整块 ≤ AW_MEMORY_INJECT_TOTAL(500)
    const explicit = recallOpts.budgetTokens ?? this.opts.budgetTokens
    const budget = explicit ?? envNum('AW_MEMORY_PRIMER_TOKENS', 300)
    const totalBudget = explicit ?? envNum('AW_MEMORY_INJECT_TOTAL', 500)
    const scope = recallOpts.scope ?? 'auto'
    const scored = await this.rank(query, scope, { excludeCurated: true, relatedTaskIds: recallOpts.relatedTaskIds })

    const lines: string[] = []
    const touched: string[] = []
    let usedTotal = 0
    // L0 会话简报置顶(幂等单行;确定性注入,不依赖检索命中;计费走总预算,不挤占 L1 引子预算)
    const briefRef = this.repo.findByAgentDedup(this.opts.channelId, this.opts.agentId, `brief:${this.opts.agentId}`)
    const briefRow = briefRef ? this.repo.getById(briefRef.id) : null
    if (briefRow) {
      const briefText = `## 会话简报(自动维护)\n${unsegmentCJK(briefRow.content)}`
      const briefCost = estimateTokens(briefText)
      if (usedTotal + briefCost <= totalBudget) {
        usedTotal += briefCost
        lines.push(briefText)
      }
    }
    // 使用提示预留计费:正文与提示共享预算,提示永不超卖
    const tipsText = [
      `记忆使用提示:`,
      `- 以上只是线索级摘要。开工前先判断是否需要更多上下文:历史结论/团队约定/相似任务经验 → 调 search_memory(query, scope) 主动检索(覆盖私有+共享域)。`,
      `- 作业中发现可复用的结论、约定、教训 → 立即 save_memory 沉淀:scope=private 存个人经验,scope=shared 发布到 Channel 公共记忆供全员复用。`,
    ].join('\n')
    const tipsCost = estimateTokens(tipsText)
    // MMR 装配:逐条贪心选 λ×相关性 − (1−λ)×与已选集最大相似 的最大者(多样性,防近重复挤占)
    const candidates = scored.slice()
    const tokenSet = (row: MemoryRow): Set<string> =>
      new Set(unsegmentCJK(`${row.title} ${row.content.slice(0, 200)}`).toLowerCase().split(/\s+/).filter(Boolean))
    const selectedTokens: Set<string>[] = []
    let usedPrimer = 0
    while (candidates.length > 0 && lines.length < 12) {
      let bestIdx = -1
      let bestGain = -Infinity
      let bestTokens: Set<string> | null = null
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]!
        const toks = tokenSet(c.row)
        let maxSim = 0
        for (const st of selectedTokens) {
          if (st.size === 0 || toks.size === 0) continue
          let inter = 0
          for (const t of toks) if (st.has(t)) inter++
          const sim = inter / (st.size + toks.size - inter)
          if (sim > maxSim) maxSim = sim
        }
        const gain = MMR_LAMBDA * c.score - (1 - MMR_LAMBDA) * maxSim
        if (gain > bestGain) {
          bestGain = gain
          bestIdx = i
          bestTokens = toks
        }
      }
      if (bestIdx < 0) break
      const [c] = candidates.splice(bestIdx, 1)
      const line = this.formatLine(c!.row)
      const cost = estimateTokens(line)
      // 双预算:L1 引子预算(budget)+ 注入总预算(total,含 brief);超预算跳过但继续找更短行
      if (usedPrimer + tipsCost + cost > budget || usedTotal + cost + tipsCost > totalBudget) continue
      usedPrimer += cost
      usedTotal += cost
      lines.push(line)
      selectedTokens.push(bestTokens!)
      if (doTouch) touched.push(c!.row.id)
    }
    if (lines.length === 0) return null
    for (const id of touched) this.repo.touch(id)
    return [
      `## 相关记忆(自动召回的高相关/最近线索摘要;与当前任务冲突时,以当前任务为准)`,
      ...lines,
      tipsText,
    ].join('\n')
  }

  /**
   * 工具按需抓取(search_memory):结构化片段返回,content 还原为未切分原文。
   * 触发 touch(access_count 强化后续召回排序);limit 上限防御;
   * relatedTaskIds 透传任务关联加权(与 recall 同源排序)。
   */
  async recallRows(query: string, opts: { scope?: MemoryScope, limit?: number, relatedTaskIds?: string[] } = {}): Promise<MemorySnippet[]> {
    const scope = opts.scope ?? 'auto'
    const limit = Math.min(Math.max(opts.limit ?? 5, 1), 20)
    const scored = (await this.rank(query, scope, { relatedTaskIds: opts.relatedTaskIds })).slice(0, limit)
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
    // 共享约定进入简报"团队共享约定"行
    if (shared) await this.updateBrief()
    return { scope: input.scope, dedupKey }
  }

  /** run 后(任务路径;仅终态调用):harvest TaskEngine 终态 + deliverable,并刷新 L0 简报 */
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
    await this.updateBrief()
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

  // ===== 上下文治理/团队历史(P0-3 新增写入面;全部幂等 upsert)=====

  /** 会话压缩摘要序号(每实例自增;dedupKey 防同幂键覆盖) */
  private sessionSeq = 0

  /**
   * 压缩摘要入库(compaction harvest):kind=episodic-session,14d 保鲜,向量化一次。
   * 三路统一入口(平台主动 compact / omp 阈值自动 / overflow),dedupKey 含序号防互踩。
   */
  async recordSessionCompaction(input: { summary: string, tokensBefore?: number, tokensAfter?: number, reason?: string }): Promise<{ dedupKey: string }> {
    this.sessionSeq += 1
    const dedupKey = `session:${this.opts.agentId}:c${this.sessionSeq}`
    const meta: string[] = []
    if (typeof input.tokensBefore === 'number') meta.push(`压缩前 ${input.tokensBefore} tok`)
    if (typeof input.tokensAfter === 'number') meta.push(`压缩后约 ${input.tokensAfter} tok`)
    if (input.reason) meta.push(`触发=${input.reason}`)
    const head = meta.length > 0 ? `[会话压缩摘要 · ${meta.join(' · ')}]\n` : '[会话压缩摘要]\n'
    this.repo.upsert({
      channelId: this.opts.channelId,
      agentId: this.opts.agentId,
      kind: 'episodic-session',
      title: `会话压缩摘要 #${this.sessionSeq}`,
      titleFts: segmentCJK('会话压缩摘要'),
      content: segmentCJK(`${head}${input.summary}`).slice(0, CONTENT_STORE_LIMIT),
      importance: 0.75,
      taskId: null,
      dedupKey,
    })
    await this.vectorize(input.summary, dedupKey)
    return { dedupKey }
  }

  /**
   * L0 会话简报刷新(零 LLM 模板拼装;brief:<agentId> 幂等单行;免向量化——
   * 确定性层恒注入,无需被检索;FTS 仍可命中)。数据源=本人已有记忆行,零额外查询依赖。
   */
  async updateBrief(): Promise<void> {
    const own = this.repo.listByAgentChannel(this.opts.channelId, this.opts.agentId, 40)
      .filter(r => r.kind === 'episodic-task')
    const shared = this.repo.listByAgentChannel(this.opts.channelId, TEAM_AGENT_ID, 40)
      .filter(r => r.kind === 'semantic')
    const lines: string[] = []
    const done = own.filter(r => r.importance >= 0.75).slice(0, 3)
    if (done.length > 0) {
      lines.push(`最近完成:`)
      done.forEach((r, i) => {
        lines.push(`${i + 1}) ${r.title} — ${unsegmentCJK(r.content).slice(0, 30)}`)
      })
    }
    if (shared.length > 0) {
      lines.push(`团队共享约定:${shared.slice(0, 2).map(r => r.title).join(';')}`)
    }
    if (lines.length === 0) return
    this.repo.upsert({
      channelId: this.opts.channelId,
      agentId: this.opts.agentId,
      kind: 'brief',
      title: '会话简报',
      titleFts: segmentCJK('会话简报'),
      content: segmentCJK(lines.join('\n')),
      importance: 0.6,
      taskId: null,
      dedupKey: `brief:${this.opts.agentId}`,
    })
  }

  /**
   * 团队任务成果入共享域(挂 channel task 终态事件;team-task:<taskId> 幂等;向量化)。
   * 全员 search_memory(scope=shared) 即可命中"谁做完了什么/为什么失败"。
   */
  async appendTeamTaskRecord(input: { taskId: string, title: string, content: string, importance: number }): Promise<void> {
    const dedupKey = `team-task:${input.taskId}`
    this.repo.upsert({
      channelId: this.opts.channelId,
      agentId: TEAM_AGENT_ID,
      kind: 'episodic-team-task',
      title: input.title,
      titleFts: segmentCJK(input.title),
      content: segmentCJK(input.content).slice(0, CONTENT_STORE_LIMIT),
      importance: input.importance,
      taskId: input.taskId,
      dedupKey,
    })
    await vectorizeMemory(this.repo, this.embedder, this.opts.channelId, TEAM_AGENT_ID, dedupKey, input.content)
  }

  /** 团队编年史滚动重写(chronicle:<channelId> 幂等单行;免向量化;策展层豁免维护) */
  upsertChronicle(entriesText: string): void {
    this.repo.upsert({
      channelId: this.opts.channelId,
      agentId: TEAM_AGENT_ID,
      kind: 'chronicle',
      title: '团队编年史',
      titleFts: segmentCJK('团队编年史'),
      content: segmentCJK(entriesText).slice(0, 1500),
      importance: 0.9,
      taskId: null,
      dedupKey: `chronicle:${this.opts.channelId}`,
    })
  }

  /** 空闲反思行(reflection:<agentId>:<month> 幂等单行;免向量化;策展层豁免维护) */
  upsertReflection(input: { month: string, content: string }): void {
    this.repo.upsert({
      channelId: this.opts.channelId,
      agentId: this.opts.agentId,
      kind: 'reflection',
      title: `作业反思 ${input.month}`,
      titleFts: segmentCJK(`作业反思 ${input.month}`),
      content: segmentCJK(input.content).slice(0, CONTENT_STORE_LIMIT),
      importance: 0.7,
      taskId: null,
      dedupKey: `reflection:${this.opts.agentId}:${input.month}`,
    })
  }

  /** kind 感知综合分:时近衰减按 kind 半衰期(知识/策展层不随时间贬值) */
  private score(row: MemoryRow, relevance: number): number {
    const halfLife = RECENCY_HALF_LIFE_DAYS[row.kind] ?? 7
    const ageDays = (Date.now() - Date.parse(row.createdAt)) / 86_400_000
    const recency = halfLife <= 0 ? 1 : Math.exp(-ageDays / halfLife)
    const importance = Math.min(1, row.importance + row.accessCount * 0.05)
    return W_RELEVANCE * relevance + W_RECENCY * recency + W_IMPORTANCE * importance
  }

  private formatLine(row: MemoryRow): string {
    const tag = ({
      'episodic-task': '任务',
      'episodic-team-task': '团队任务',
      'episodic-peer': '协作',
      'episodic-session': '会话',
      'brief': '简报',
      'chronicle': '编年史',
      'reflection': '反思',
    } as Record<string, string>)[row.kind] ?? '共享'
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
 * 记忆维护:① episodic 过期删除(now - (lastAccessedAt ?? createdAt) > 过期天数;
 * kind 分离:episodic-session 14d / 其余 episodic 180d)
 * ② 每 agent 容量淘汰(仅 episodic 族;effectiveScore = importance + accessCount×0.05 降序保留)
 * ③ team 域行:episodic-team-task 同样过期+淘汰(防共享域膨胀);chronicle/semantic 策展行豁免
 * ④ 孤儿 vec 清理。semantic / brief / chronicle / reflection 全程豁免(单行幂等自限)。
 */
export function runMemoryMaintenance(
  repo: MemoryRepo,
  opts: { expireDays?: number, cap?: number } = {},
): MaintenanceResult {
  const expireDays = opts.expireDays ?? envNum('AW_MEMORY_EXPIRE_DAYS', 180)
  const sessionExpireDays = envNum('AW_MEMORY_EXPIRE_SESSION_DAYS', 14)
  const cap = opts.cap ?? envNum('AW_MEMORY_CAP', 500)
  const now = Date.now()
  let deletedExpired = 0
  let evicted = 0

  /** 过期天数按 kind 分离(session 摘要短保鲜) */
  const expireMsFor = (kind: string): number =>
    (kind === 'episodic-session' ? sessionExpireDays : expireDays) * 86_400_000

  /** 对一组行执行 ①过期 ②容量淘汰(仅传入选定行;调用方负责 kind 圈定) */
  const expireAndEvict = (rows: Array<MemoryRow & { rowid: number }>): void => {
    for (const r of rows) {
      if (now - Date.parse(r.lastAccessedAt ?? r.createdAt) > expireMsFor(r.kind)) {
        repo.vecDelete(r.rowid)
        repo.delete(r.id)
        deletedExpired++
      }
    }
    const remaining = rows.filter(r => repo.getById(r.id) !== null)
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

  // 成员私有域(排除 team)
  for (const agentId of repo.listMemoryAgentIds()) {
    expireAndEvict(repo.listByAgentWithRowid(agentId, 1_000_000)
      .filter(r => r.kind.startsWith('episodic')))
  }
  // team 共享域:仅 episodic-team-task 参与过期/淘汰(chronicle/semantic 策展行豁免)
  expireAndEvict(repo.listByAgentWithRowid(TEAM_AGENT_ID, 1_000_000)
    .filter(r => r.kind === 'episodic-team-task'))
  let cleanedVec = 0
  try {
    cleanedVec = repo.vecCleanOrphans()
  }
  catch { /* vec 未启用 */ }
  return { deletedExpired, evicted, cleanedVec }
}
