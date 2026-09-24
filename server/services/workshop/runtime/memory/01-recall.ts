/**
 * AgentMemoryLayer01 —— 检索:命中收集 / 重排 / recall 与 recallRows
 * (分层 2/5,承 AgentMemoryLayer00;方法体与原文件逐行一致)
 */
import { AgentMemoryLayer00 } from './00-state'
import type { MemoryRow } from '../../db/database'
import type { MemoryScope, MemorySnippet, RecallOptions } from './types'
import { CURATED_KINDS, FTS_POOL, MMR_LAMBDA, RECENT_FALLBACK, RELATED_TASK_BOOST, RRF_K, buildMatchQuery, estimateTokens, memoryCfg, unsegmentCJK } from './helpers'
import { TEAM_AGENT_ID } from '../../db/memory.repo'

export abstract class AgentMemoryLayer01 extends AgentMemoryLayer00 {
  /**
   * 混合检索原始命中(RRF 融合;不排序不 touch)。
   * FTS 榜与向量榜各按名次贡献 1/(k+rank) 累加,再按榜内最高分归一化到 0-1——
   * 相比 v1 的 max 距离归一化,弱首命中/两榜分纲不一致时排序依然稳定。
   */
  protected async collectHits(query: string, scope: MemoryScope): Promise<Map<string, { row: MemoryRow, relevance: number }>> {
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
  protected async rank(
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
    // 未显式设置 = 双预算:L1 引子 ≤ memory.primer_tokens(300),整块 ≤ memory.inject_total(500)
    const explicit = recallOpts.budgetTokens ?? this.opts.budgetTokens
    const budget = explicit ?? memoryCfg().primer_tokens
    const totalBudget = explicit ?? memoryCfg().inject_total
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
        // §7.4 DTO 必带:来源 Channel / task / 可见性。
        // rootId 由上层(manager 持有 TaskEngine)补齐 —— 记忆层不查任务表。
        channelId: s.row.channelId,
        taskId: s.row.taskId ?? null,
        visibility: shared ? 'channel-shared' as const : 'private' as const,
      }
    })
  }
}
