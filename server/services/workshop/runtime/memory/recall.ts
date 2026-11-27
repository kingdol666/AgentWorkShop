/**
 * AgentMemoryRecall —— 检索:命中收集 / 重排 / recall 与 recallRows
 * (拆分层,承 AgentMemoryState;方法体与原文件逐行一致)
 */
import { AgentMemoryState } from './state'
import type { MemoryRow, MemoryScopeKind } from '../../db/database'
import type { MemoryScope, MemorySnippet, RecallOptions, ScopeContext } from './types'
import { BIGRAM_BOARD_WEIGHT, CURATED_KINDS, FTS_POOL, MMR_LAMBDA, RECENT_FALLBACK, RELATED_TASK_BOOST, RRF_K, SAME_LINE_BOOST, SAME_PRODUCT_BOOST, SESSION_RELEVANCE_BOOST, buildBigramQuery, buildMatchQuery, estimateTokens, memoryCfg, unsegmentCJK } from './helpers'
import { TEAM_AGENT_ID } from '../../db/memory.repo'
import type { InjectionRef } from '../../memory/effect'
import { buildGraphDigest, graphRetrieve } from '../../memory/graph/retrieval'

const GRAPH_WEIGHT = 0.8
const GRAPH_POOL = 10
const GRAPH_DEADLINE_MS = 75

/** 共享区自动注入条数（0=关闭；默认 3，上限 10） */
function memorySharedTopN(): number {
  const raw = Number(process.env.AW_MEMORY_SHARED_TOP_N ?? '3')
  return Number.isFinite(raw) ? Math.max(0, Math.min(10, Math.floor(raw))) : 3
}

/** 共享区块 token 预算（默认 150；与 L1/brief 同属 inject_total 总额，不额外加总） */
function memorySharedTokens(): number {
  const raw = Number(process.env.AW_MEMORY_SHARED_TOKENS ?? '150')
  return Number.isFinite(raw) ? Math.max(0, Math.min(400, Math.floor(raw))) : 150
}

export abstract class AgentMemoryRecall extends AgentMemoryState {
  /**
   * 作用域上下文(WP-A3):显式入参优先;缺省按频道产线绑定解析(lineId)。
   * 解析失败/未绑定 → 空上下文(零加分,行为与旧版一致)。
   */
  protected resolveScopeContext(given?: ScopeContext): ScopeContext {
    if (!given) return this.trustedScopeContext
    return {
      lineId: given.lineId && given.lineId !== this.trustedScopeContext.lineId ? this.trustedScopeContext.lineId : given.lineId ?? this.trustedScopeContext.lineId,
      productId: given.productId && given.productId !== this.trustedScopeContext.productId ? this.trustedScopeContext.productId : given.productId ?? this.trustedScopeContext.productId,
    }
  }

  /** 经验作用域加分(WP-A3):同产线 +0.2 / 同产品 +0.1(非经验行/未绑定 → 0) */
  protected scopeBoost(row: MemoryRow, ctx: ScopeContext): number {
    if (row.kind !== 'experience' || !row.scopeKind || !row.scopeKey) return 0
    if (row.scopeKind === 'line' && ctx.lineId && row.scopeKey === ctx.lineId) return SAME_LINE_BOOST
    if (row.scopeKind === 'product' && ctx.productId && row.scopeKey === ctx.productId) return SAME_PRODUCT_BOOST
    return 0
  }

  /** 图谱检索分区：session/channel/line/product 分开，session 只取当前会话；isolated 不取 line/product。 */
  protected graphScope(scope: MemoryScope, sessionId?: string | null): {
    scopeKinds: MemoryScopeKind[]
    scopeKeys: string[]
  } | null {
    const mode = this.repo.memoryAccessMode(this.opts.channelId, sessionId)
    if (mode === 'disabled') return null
    const sessionKey = sessionId ?? ''
    if (scope === 'session') {
      return sessionKey ? { scopeKinds: ['session'], scopeKeys: [sessionKey] } : null
    }
    if (scope === 'private') {
      return sessionKey
        ? { scopeKinds: ['session', 'channel'], scopeKeys: [sessionKey, ''] }
        : { scopeKinds: ['channel'], scopeKeys: [''] }
    }
    if (scope === 'shared') return { scopeKinds: ['channel'], scopeKeys: [''] }
    // auto：会话 + 频道 +（非 isolated 的工业上下文）line/product。
    const kinds: MemoryScopeKind[] = ['session', 'channel']
    const keys: string[] = [sessionKey, '']
    if (mode !== 'isolated' && this.opts.industrialScopeEnabled === true) {
      if (this.trustedScopeContext.lineId) {
        kinds.push('line')
        keys.push(this.trustedScopeContext.lineId)
      }
      if (this.trustedScopeContext.productId) {
        kinds.push('product')
        keys.push(this.trustedScopeContext.productId)
      }
    }
    return { scopeKinds: kinds, scopeKeys: keys }
  }

  /**
   * 混合检索原始命中(RRF 融合;不排序不 touch)。
   * FTS 榜与向量榜各按名次贡献 1/(k+rank) 累加,再按榜内最高分归一化到 0-1——
   * 相比 v1 的 max 距离归一化,弱首命中/两榜分纲不一致时排序依然稳定。
   */
  protected async collectHits(query: string, scope: MemoryScope, sessionId?: string | null, scopeContext?: ScopeContext, automatic = false, signal?: AbortSignal, asOf?: string | null): Promise<Map<string, { row: MemoryRow, relevance: number }>> {
    signal?.throwIfAborted()
    const rrf = new Map<string, { row: MemoryRow, score: number }>()
    const addRank = (row: MemoryRow, rank: number, weight = 1): void => {
      // 人类对话摘要只供显式检索，不进自动注入（批次 B / M4）
      if (automatic && row.kind === 'episodic-dialog') return
      if (!this.inScope(row, scope, sessionId, scopeContext, automatic, asOf)) return
      const inc = weight / (RRF_K + rank + 1)
      const cur = rrf.get(row.id)
      if (cur) cur.score += inc
      else rrf.set(row.id, { row, score: inc })
    }
    const match = buildMatchQuery(query)
    const searchOpts = {
      ...(sessionId && scope === 'session' ? { sessionId } : {}),
      channelId: this.opts.channelId,
    }
    if (match) {
      const found = this.repo.search(this.opts.agentId, match, FTS_POOL, searchOpts)
      found.forEach((row, i) => addRank(row, i))
      // 精度榜(二元短语):单字 OR 榜对共享高频字不设防,新鲜过程行靠字面重叠
      // 就能把真含该词的知识行挤出前列(实测:唯一中文词查询语义行排 11/20)。
      // 相邻字对短语只在「词真的出现」时命中,给精确命中一条独立高权重 RRF 榜。
      const bigram = buildBigramQuery(query)
      if (bigram) {
        const precise = this.repo.search(this.opts.agentId, bigram, FTS_POOL, searchOpts)
        precise.forEach((row, i) => addRank(row, i, BIGRAM_BOARD_WEIGHT))
      }
    }
    // 查询向量只算一次：记忆向量榜与实体向量种子复用（失败退化纯 FTS）
    let qv: Float32Array | null = null
    if (this.embedder) {
      try {
        const [v] = await this.embedder.embed([query])
        qv = v ?? null
      }
      catch { qv = null }
      signal?.throwIfAborted()
    }
    // 向量分支: 查询向量 + 本人/team 双域 kNN,按距离名次参与 RRF
    if (qv) {
      try {
        this.ensureVec()
        const ownDomains: string[]
          = scope === 'shared'
            ? [TEAM_AGENT_ID]
            : scope === 'private' || scope === 'session'
              ? [this.opts.agentId]
              : [this.opts.agentId, TEAM_AGENT_ID]
        const vAll = ownDomains.flatMap(d =>
          this.repo.vecSearch(d, qv!, d === TEAM_AGENT_ID ? 5 : 10))
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
      catch { /* 向量不可用退化为 FTS */ }
      signal?.throwIfAborted()
    }
    // 图谱分支（批次 Memory Graph）：实体种子 → PPR → 记忆投影 → RRF 加权并入。
    // 只在 ENABLE 且 scope 允许时执行；超时/异常静默退化，不影响 FTS/向量。
    if (process.env.AW_MEMORY_GRAPH_RETRIEVAL !== '0' && this.repo.graph.available) {
      try {
        const graphScope = this.graphScope(scope, sessionId)
        if (graphScope && (graphScope.scopeKeys.some(Boolean) || graphScope.scopeKinds.includes('channel'))) {
          const graph = graphRetrieve(this.repo.graph, this.opts.channelId, query, {
            asOf, qv, ...graphScope, seedLimit: 8, limitNodes: 300, limitEdges: 1200,
          })
          if (graph.durationMs <= GRAPH_DEADLINE_MS && graph.memoryScores.size > 0) {
            const ranked = [...graph.memoryScores.entries()]
              .sort((a, b) => b[1].score - a[1].score)
              .slice(0, GRAPH_POOL)
            for (let i = 0; i < ranked.length; i++) {
              const row = this.repo.getById(ranked[i]![0])
              if (row) addRank(row, i, GRAPH_WEIGHT)
            }
          }
        }
      }
      catch { /* 图谱不可用退化 FTS/向量 */ }
      signal?.throwIfAborted()
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
    if (scope !== 'shared' && scope !== 'session') {
      for (const row of this.repo.listRecent(this.opts.agentId, RECENT_FALLBACK, { channelId: this.opts.channelId })) {
        if (!this.inScope(row, scope, sessionId, scopeContext, automatic, asOf)) continue
        if (row.deletedAt) continue
        if (CURATED_KINDS.has(row.kind)) continue
        if (row.kind === 'episodic-dialog') continue
        // RSI(WP-A3):时近兜底同样排除退休经验(兜底路径不经 inScope)
        if (row.status === 'retired') continue
        if (!hits.has(row.id)) hits.set(row.id, { row, relevance: 0.15 })
      }
    }
    return hits
  }

  /** 排序(综合分降序;策展层排除/任务关联加权/session 行加分/经验作用域加分;不含预算/touch 副作用) */
  protected async rank(
    query: string,
    scope: MemoryScope,
    opts: { excludeCurated?: boolean, relatedTaskIds?: string[], sessionId?: string | null, scopeContext?: ScopeContext, automatic?: boolean, signal?: AbortSignal, asOf?: string | null } = {},
  ): Promise<Array<{ row: MemoryRow, relevance: number, score: number }>> {
    opts.signal?.throwIfAborted()
    const hits = await this.collectHits(query, scope, opts.sessionId, opts.scopeContext, opts.automatic ?? false, opts.signal, opts.asOf)
    opts.signal?.throwIfAborted()
    const related = opts.relatedTaskIds && opts.relatedTaskIds.length > 0 ? new Set(opts.relatedTaskIds) : null
    const scopeCtx = this.resolveScopeContext(opts.scopeContext)
    return [...hits.values()]
      .filter(h => !opts.excludeCurated || !CURATED_KINDS.has(h.row.kind))
      .map((h) => {
        let score = this.score(h.row, h.relevance)
        if (related && h.row.taskId && related.has(h.row.taskId)) {
          score = Math.min(1, score + RELATED_TASK_BOOST)
        }
        // session 行加分(auto 档):当前会话作用域的记忆排序偏好(不过滤,其余照常)
        if (opts.sessionId && scope === 'auto' && h.row.sessionId === opts.sessionId) {
          score = Math.min(1, score + SESSION_RELEVANCE_BOOST)
        }
        // 经验作用域加分(WP-A3):同产线/同产品经验优先(排序偏好,不做跨频道授权)
        const boost = this.scopeBoost(h.row, scopeCtx)
        if (boost > 0) score = Math.min(1, score + boost)
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
    recallOpts.signal?.throwIfAborted()
    const doTouch = recallOpts.touch !== false
    // 显式 budgetTokens(实例/调用级)= 整块记忆硬顶(L0 简报+L1 引子+提示全计入);
    // 未显式设置 = 双预算:L1 引子 ≤ memory.primer_tokens(300),整块 ≤ memory.inject_total(500)
    const explicit = recallOpts.budgetTokens ?? this.opts.budgetTokens
    const budget = explicit ?? memoryCfg().primer_tokens
    const totalBudget = explicit ?? memoryCfg().inject_total
    const scope = recallOpts.scope ?? 'auto'
    const sessionId = recallOpts.sessionId ?? this.opts.sessionId
    const accessMode = this.repo.memoryAccessMode(this.opts.channelId, sessionId)
    if (accessMode === 'disabled') return null
    const scored = await this.rank(query, scope, { excludeCurated: true, relatedTaskIds: recallOpts.relatedTaskIds, sessionId, scopeContext: recallOpts.scopeContext, automatic: true, signal: recallOpts.signal, asOf: recallOpts.asOf })
    recallOpts.signal?.throwIfAborted()

    const lines: string[] = []
    const touched: string[] = []
    const injectedRefs: InjectionRef[] = []
    let usedTotal = 0
    // L0 会话简报置顶(幂等单行;确定性注入,不依赖检索命中;计费走总预算,不挤占 L1 引子预算)
    const briefKey = `brief:${this.opts.agentId}:${sessionId || 'channel'}`
    let briefRef = this.repo.findByAgentDedup(this.opts.channelId, this.opts.agentId, briefKey)
    // 兼容旧版频道级简报键；旧键若带其他会话戳则拒绝（只接受空会话/当前会话）。
    if (!briefRef) {
      const legacy = this.repo.findByAgentDedup(this.opts.channelId, this.opts.agentId, `brief:${this.opts.agentId}`)
      const legacyRow = legacy ? this.repo.getById(legacy.id) : null
      if (legacy && legacyRow && (!legacyRow.sessionId || legacyRow.sessionId === sessionId)) briefRef = legacy
    }
    const briefRow = briefRef ? this.repo.getById(briefRef.id) : null
    const briefAt = recallOpts.asOf ? Date.parse(recallOpts.asOf) : Date.now()
    const briefValid = briefRow && briefRow.status !== 'retired'
      && (!briefRow.validFrom || Date.parse(briefRow.validFrom) <= briefAt)
      && (!briefRow.validTo || Date.parse(briefRow.validTo) > briefAt)
    if (briefRow && briefValid) {
      const briefText = `## 会话简报(自动维护)\n${unsegmentCJK(briefRow.content)}`
      const briefCost = estimateTokens(briefText)
      if (usedTotal + briefCost <= totalBudget) {
        usedTotal += briefCost
        lines.push(briefText)
        injectedRefs.push({ id: briefRow.id, kind: briefRow.kind, source: 'brief' })
      }
    }
    // 使用提示预留计费:正文与提示共享预算,提示永不超卖
    const tipsText = [
      `记忆使用提示:`,
      `- 以上只是线索级摘要。开工前先判断是否需要更多上下文:历史结论/团队约定/相似任务经验 → 调 search_memory(query, scope) 主动检索(覆盖私有+共享域)。`,
      `- 作业中发现可复用的结论、约定、教训 → 立即 save_memory 沉淀:scope=private 存个人经验,scope=shared 发布到 Channel 公共记忆供全员复用。`,
    ].join('\n')
    const tipsCost = estimateTokens(tipsText)
    // 注入块头部(标题行)也计费:否则硬顶被标题突破(A-5.1 实测 527>500)
    const headerText = `## 相关记忆(自动召回的高相关/最近线索摘要;与当前任务冲突时,以当前任务为准)`
    const headerCost = estimateTokens(headerText)
    // L0.4 Core Blocks + Runtime Working Memory + /memories 索引（批次 J）
    try {
      if (accessMode === 'inherit' || accessMode === 'isolated' || accessMode === 'readonly') {
        const scopeIds = [`channel:${this.opts.channelId}`]
        if (sessionId) scopeIds.push(`session:${sessionId}`)
        const blocks = this.repo.listMemoryBlocks(scopeIds).filter(b => b.value.trim())
        const working = this.repo.loadWorkingMemory(this.opts.agentId, sessionId, recallOpts.trace?.taskId ?? null)
        const docs = this.repo.documentIndex(scopeIds, 8)
        const parts: string[] = []
        for (const b of blocks.slice(0, 6)) parts.push(`- [${b.label}] ${b.value.slice(0, 240)}${b.locked ? ' 🔒' : ''}`)
        for (const w of working.slice(0, 4)) parts.push(`- [工作记忆/${w.key}] ${w.value.slice(0, 160)}`)
        if (docs.length > 0) parts.push(`- /memories 索引：${docs.slice(0, 8).map(d => `${d.path}(${d.size}B,r${d.revision})`).join('；')}`)
        if (parts.length > 0) {
          const text = `## 核心记忆块 / 工作记忆\n${parts.join('\n')}`
          const cost = estimateTokens(text)
          if (cost <= 260 && usedTotal + cost + tipsCost + headerCost <= totalBudget) {
            usedTotal += cost
            lines.push(text)
            for (const b of blocks.slice(0, 6)) injectedRefs.push({ id: b.id, kind: 'block', source: 'brief', scopeKind: b.scopeKind, scopeKey: b.scopeKey })
          }
        }
      }
    }
    catch { /* Fabric 读取失败不阻断召回 */ }
    // L0.5 Curator 知识手册（汇整层）：brief 之后、L1 引子之前；≤200 tok；只取摘要。
    // 优先级：product > line > channel（repo 已按 scope/pin/新近排序）；完整文档在 /memory 查看。
    try {
      const curated = this.repo.listCuratedForInjection(this.opts.channelId, {
        // isolated 策略不读 line/product 派生文档（与 inScope 的隔离语义一致）。
        lineId: accessMode === 'isolated' ? null : this.trustedScopeContext.lineId,
        productId: accessMode === 'isolated' ? null : this.trustedScopeContext.productId,
        limit: 2,
      })
      let curatedUsed = 0
      const curatedBudget = 200
      for (const row of curated) {
        const body = unsegmentCJK(String(row.content ?? ''))
          .replace(/^#.*$/gm, '')
          .replace(/^>.*$/gm, '')
          .replace(/\n{2,}/g, '\n')
          .trim()
          // L0.5 只取摘要（≤200 tok；CJK 约 1 字/ token）
          .slice(0, 100)
        const text = `## 知识手册（汇整摘要）\n${body}`
        const cost = estimateTokens(text)
        if (curatedUsed + cost > curatedBudget) continue
        if (usedTotal + cost + tipsCost + headerCost > totalBudget) continue
        curatedUsed += cost
        usedTotal += cost
        lines.push(text)
        injectedRefs.push({ id: row.id, kind: row.kind, source: 'curated', scopeKind: row.scopeKind, scopeKey: row.scopeKey })
      }
      // 知识网络摘要（GraphRAG 社区/事实）：与 curated 共用 200 tok 预算，不额外加总。
      if (process.env.AW_MEMORY_GRAPH_RETRIEVAL !== '0' && this.repo.graph.available) {
        try {
          const graphScope = this.graphScope(scope, sessionId)
          if (graphScope && (graphScope.scopeKeys.some(Boolean) || graphScope.scopeKinds.includes('channel'))) {
            const digest = buildGraphDigest(this.repo.graph, this.opts.channelId, query, {
              asOf: recallOpts.asOf ?? null, ...graphScope, seedLimit: 8, limitNodes: 300, limitEdges: 1200,
              // L0.5 与知识手册共用 200 tok；单条事实 + 社区才放得下。
              maxFacts: 1,
            })
            if (digest) {
              const cost = estimateTokens(digest.text)
              if (curatedUsed + cost <= curatedBudget && usedTotal + cost + tipsCost + headerCost <= totalBudget) {
                curatedUsed += cost
                usedTotal += cost
                lines.push(digest.text)
                for (const ref of digest.refs) injectedRefs.push({ ...ref, source: 'graph' })
              }
            }
          }
        }
        catch { /* 图谱摘要失败不阻断召回 */ }
      }
    }
    catch { /* 汇整层故障不阻断召回 */ }
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
      // 双预算:L1 引子预算(budget)+ 注入总预算(total,含 brief/头部/提示);超预算跳过但继续找更短行
      if (usedPrimer + tipsCost + headerCost + cost > budget || usedTotal + cost + tipsCost + headerCost > totalBudget) continue
      usedPrimer += cost
      usedTotal += cost
      lines.push(line)
      injectedRefs.push({ id: c!.row.id, kind: c!.row.kind, source: 'primer', scopeKind: c!.row.scopeKind, scopeKey: c!.row.scopeKey })
      selectedTokens.push(bestTokens!)
      if (doTouch) touched.push(c!.row.id)
    }
    // L2 共享区（owner 级 `scope_kind='global'`）：独立预算 ≤150 tok，计入 inject_total 总额。
    // 只取人工行 / 已验证经验 / active 语义行；pin 优先（repo 内 ORDER BY）。
    const sharedLimit = memorySharedTopN()
    if (sharedLimit > 0 && accessMode === 'inherit') {
      const owner = this.opts.ownerUserId ?? this.repo.contextFor(this.opts.channelId).ownerUserId
      const matchQuery = buildMatchQuery(query)
      if (owner && matchQuery) {
        const sharedBudget = memorySharedTokens()
        let sharedUsed = 0
        let sharedCount = 0
        for (const row of this.repo.searchWorkspaceShared(matchQuery, owner, sharedLimit + 2)) {
          if (sharedCount >= sharedLimit) break
          const tag = row.authorKind === 'human' ? '[人工]' : (row.kind === 'experience' && row.status === 'validated' ? '[已验证]' : '')
          const title = row.title
          const body = unsegmentCJK(String(row.content ?? '')).slice(0, 160)
          const line = `  [共享区${tag ? ` ${tag}` : ''} · ${row.pinned ? 'pin · ' : ''}${row.scopeKind ?? 'global'}] ${title}：${body}`
          const cost = estimateTokens(line)
          if (sharedUsed + cost > sharedBudget) continue
          if (usedTotal + cost + tipsCost + headerCost > totalBudget) continue
          sharedUsed += cost
          usedTotal += cost
          sharedCount += 1
          lines.push(line)
          injectedRefs.push({ id: row.id, kind: row.kind, source: 'shared', scopeKind: row.scopeKind, scopeKey: row.scopeKey })
          if (lines.length >= 15) break
        }
      }
    }
    if (lines.length === 0) return null
    for (const id of touched) this.repo.touch(id)
    if (recallOpts.trace) {
      this.repo.logInjection({
        channelId: this.opts.channelId,
        agentId: this.opts.agentId,
        sessionId,
        taskId: recallOpts.trace.taskId ?? null,
        refs: injectedRefs,
      })
    }
    return [
      headerText,
      ...lines,
      tipsText,
    ].join('\n')
  }

  /**
   * 工具按需抓取(search_memory):结构化片段返回,content 还原为未切分原文。
   * 触发 touch(access_count 强化后续召回排序);limit 上限防御;
   * relatedTaskIds 透传任务关联加权(与 recall 同源排序)。
   */
  async recallRows(query: string, opts: { scope?: MemoryScope, limit?: number, relatedTaskIds?: string[], sessionId?: string | null, scopeContext?: ScopeContext, asOf?: string | null } = {}): Promise<MemorySnippet[]> {
    const scope = opts.scope ?? 'auto'
    const limit = Math.min(Math.max(opts.limit ?? 5, 1), 20)
    // 召回度量(2026-10-05 记忆治理最小版):hit/miss 计数 —— 72% 记忆从未被召回的
    // 问题先变成可观测数据,再决定是否值得做自动合并。
    const stats = recallStatsOf()
    const sessionId = opts.sessionId ?? this.opts.sessionId
    const scoredAll = await this.rank(query, scope, { relatedTaskIds: opts.relatedTaskIds, sessionId, scopeContext: opts.scopeContext, asOf: opts.asOf })
    if (scoredAll.length > 0) stats.hits++
    else stats.misses++
    const scored = scoredAll.slice(0, limit)
    for (const s of scored) this.repo.touch(s.row.id)
    return scored.map((s) => {
      const shared = s.row.agentId === TEAM_AGENT_ID
      return {
        id: s.row.id,
        kind: s.row.kind,
        title: s.row.title,
        content: unsegmentCJK(s.row.content).slice(0, 500),
        importance: s.row.importance,
        createdAt: s.row.createdAt,
        score: Math.round(s.score * 1000) / 1000,
        source: shared ? 'shared' as const : 'private' as const,
        // §7.4 DTO 必带:来源 Channel / task / session / 可见性。
        // rootId 由上层(manager 持有 TaskEngine)补齐 —— 记忆层不查任务表。
        channelId: s.row.channelId,
        taskId: s.row.taskId ?? null,
        sessionId: s.row.sessionId ?? null,
        visibility: shared ? 'channel-shared' as const : 'private' as const,
        // RSI 经验元信息(WP-A3):非经验行带默认值(neutral/session/active),调用方按 kind 判别
        outcome: s.row.outcome ?? 'neutral',
        status: s.row.status ?? 'active',
        scopeKind: s.row.scopeKind ?? 'session',
        scopeKey: s.row.scopeKey ?? '',
      }
    })
  }
}

const gRecall = globalThis as typeof globalThis & { __awRecallStats?: { hits: number, misses: number } }
function recallStatsOf(): { hits: number, misses: number } {
  gRecall.__awRecallStats ??= { hits: 0, misses: 0 }
  return gRecall.__awRecallStats
}

/** 召回度量(进程内;restart 归零 —— 趋势观测用,不承诺持久) */
export function memoryRecallStats(): { hits: number, misses: number, hitRate: string } {
  const s = recallStatsOf()
  const total = s.hits + s.misses
  return { hits: s.hits, misses: s.misses, hitRate: total ? `${Math.round((s.hits / total) * 100)}%` : 'n/a' }
}
