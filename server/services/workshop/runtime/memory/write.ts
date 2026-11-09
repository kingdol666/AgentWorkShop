/**
 * AgentMemoryWrite —— 写入:save / 任务结果 / peer 交换 / 向量化
 * (拆分层,承 AgentMemoryRecall;方法体与原文件逐行一致)
 */
import { AgentMemoryRecall } from './recall'
import type { A2AMessage } from '../../types/a2a'
import type { WorkspaceTask } from '../../types/task'
import { CONTENT_STORE_LIMIT, buildMatchQuery, partsText, segmentCJK, unsegmentCJK, vectorizeMemory } from './helpers'
import { TEAM_AGENT_ID } from '../../db/memory.repo'
import { randomUUID } from 'node:crypto'

export abstract class AgentMemoryWrite extends AgentMemoryRecall {
  /**
   * Agent 主动沉淀(save_memory 工具):把作业过程中的可复用结论/经验写入记忆库。
   * scope='private' → 本人 semantic 域;scope='shared' → Channel 公共域(全员可检索;
   * dedupKey 按来源 Agent 命名空间隔离,避免多 Agent 同 key 互相覆盖)。写入后自动向量化。
   *
   * RSI(WP-A4)扩展:scope='line'|'global' → **经验条目**(kind=experience)。
   *  - 必须带 taskId 锚点(无锚点自述不配进跨频道经验层,fail-closed);
   *  - 需要会话 memoryPolicy='shared'(否则拒绝,不静默降级);
   *  - line 需要频道已绑定产线(scope_key=channels.line_id);
   *  - 一律 status='candidate'(先验证再晋级,ADR-7),outcome='unknown'。
   */
  async save(input: {
    title: string
    content: string
    importance?: number
    scope: 'private' | 'shared' | 'line' | 'global'
    dedupKey?: string
    sessionId?: string | null
    /** 跨频道经验的证据锚点(scope=line|global 必填) */
    taskId?: string | null
  }): Promise<{ scope: 'private' | 'shared' | 'line' | 'global', dedupKey: string }> {
    if (input.scope === 'line' || input.scope === 'global') {
      const expScope: 'line' | 'global' = input.scope
      return this.saveExperience({ ...input, scope: expScope })
    }
    const shared = input.scope === 'shared'
    const rawKey = input.dedupKey?.trim() || `agent-save:${randomUUID().slice(0, 8)}`
    // 共享域命名空间:同 channel 多 agent 各自的沉淀互不覆盖
    const dedupKey = shared ? `agent:${this.opts.agentId}:${rawKey}` : rawKey
    const owner = shared ? TEAM_AGENT_ID : this.opts.agentId
    // 共享域近邻治理(2026-10-05 记忆治理最小版):同一事实多 agent 各写一条永不合并
    // (lead ~1.0 与 worker ~0.09 并存靠当场甄别)。写入前查共享域近邻:
    //   标题高度重合 + 数值一致 → 并入既有条目(追加并存来源,不新建);
    //   数值矛盾 → 新条目标 [contested](两条并存,矛盾显式化)。
    let title = input.title
    const content = input.content
    let finalKey = dedupKey
    if (shared) {
      // 近邻检索必须走 buildMatchQuery:标题原文直喂 FTS5 时,`10:30`/`2026-10-07` 这类
      // "数字:数字/含:+-"片段会被解析成列过滤器/短语算子 → "no such column: 10"
      // (实测:跨频道冻结约定标题含时间戳,save_memory 全量炸掉)。
      const matchQuery = buildMatchQuery(input.title)
      const near = matchQuery
        ? this.repo.search(TEAM_AGENT_ID, matchQuery, 3).filter(r => r.kind === 'semantic')
        : []
      const tokensOf = (t: string) => new Set(segmentCJK(t).split(/\s+/).filter(Boolean))
      const jaccard = (a: Set<string>, b: Set<string>) => {
        const inter = [...a].filter(x => b.has(x)).length
        return inter / Math.max(1, a.size + b.size - inter)
      }
      const numsOf = (t: string) => (t.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
      for (const row of near) {
        if (jaccard(tokensOf(input.title), tokensOf(row.title)) < 0.75) continue
        const oldContent = unsegmentCJK(String(row.content ?? ''))
        const oldNums = numsOf(oldContent)
        const newNums = numsOf(input.content)
        const numbersAgree = oldNums.length > 0
          && oldNums.length === newNums.length
          && oldNums.every((v, i) => {
            const w = newNums[i] ?? Number.NaN
            return Math.abs(v - w) <= Math.max(1e-6, Math.abs(v) * 0.01)
          })
        if (numbersAgree) {
          const confirmNote = `[并存确认 ${this.opts.agentId} @${new Date().toISOString().slice(0, 16)}]`
          const merged = `${oldContent}${confirmNote}`
          const mergedTitleFts = row.titleFts ?? segmentCJK(row.title)
          const mergedDedup = row.dedupKey ?? `legacy:${row.id}`
          this.repo.upsert({
            channelId: row.channelId,
            agentId: row.agentId,
            kind: row.kind,
            title: row.title,
            titleFts: mergedTitleFts,
            content: segmentCJK(merged).slice(0, CONTENT_STORE_LIMIT),
            importance: Math.min(1, (row.importance ?? 0.8) + 0.05),
            taskId: row.taskId,
            dedupKey: mergedDedup,
          })
          await vectorizeMemory(this.repo, this.embedder, this.opts.channelId, row.agentId, mergedDedup, merged)
          return { scope: input.scope, dedupKey: mergedDedup }
        }
        title = `[contested:${row.id.slice(0, 8)}] ${title}`
        finalKey = `${dedupKey}:contested`
        break
      }
    }
    this.repo.upsert({
      channelId: this.opts.channelId,
      agentId: owner,
      kind: 'semantic',
      title,
      titleFts: segmentCJK(title),
      content: segmentCJK(content).slice(0, CONTENT_STORE_LIMIT),
      importance: input.importance ?? (shared ? 0.85 : 0.7),
      taskId: null,
      sessionId: input.sessionId ?? '',
      dedupKey: finalKey,
    })
    await vectorizeMemory(this.repo, this.embedder, this.opts.channelId, owner, finalKey, content)
    // 共享约定进入简报"团队共享约定"行
    if (shared) await this.updateBrief()
    return { scope: input.scope, dedupKey: finalKey }
  }

  /**
   * 跨频道经验写入(line/global 档;WP-A4)。
   * 纪律:策略门(shared)→ 产线绑定门(line)→ 证据锚点门(taskId)→ 一律 candidate。
   */
  protected async saveExperience(input: {
    title: string
    content: string
    importance?: number
    scope: 'line' | 'global'
    dedupKey?: string
    sessionId?: string | null
    taskId?: string | null
  }): Promise<{ scope: 'line' | 'global', dedupKey: string }> {
    const policy = this.repo.sessionMemoryPolicy(input.sessionId ?? '')
    if (policy !== 'shared') {
      throw new Error(`memory policy "${policy}" 不允许写入 ${input.scope} 作用域经验(需会话 memoryPolicy=shared)`)
    }
    if (!input.taskId) {
      throw new Error(`${input.scope} 作用域经验必须带 taskId 锚点(无证据的自述不进入跨频道经验层)`)
    }
    let scopeKey = ''
    if (input.scope === 'line') {
      scopeKey = this.repo.channelScope(this.opts.channelId).lineId ?? ''
      if (!scopeKey) throw new Error('line 作用域经验需要频道已绑定产线(channels.line_id 为空)')
    }
    const rawKey = input.dedupKey?.trim() || `agent-save:${randomUUID().slice(0, 8)}`
    const dedupKey = `exp:${input.scope}:${this.opts.agentId}:${rawKey}`
    this.repo.upsertExperience({
      channelId: this.opts.channelId,
      agentId: this.opts.agentId,
      kind: 'experience',
      title: input.title,
      titleFts: segmentCJK(input.title),
      content: segmentCJK(input.content).slice(0, CONTENT_STORE_LIMIT),
      importance: input.importance ?? 0.7,
      taskId: input.taskId,
      sessionId: input.sessionId ?? '',
      dedupKey,
      outcome: 'unknown',
      evidence: { taskIds: [input.taskId] },
      scopeKind: input.scope,
      scopeKey,
      status: 'candidate',
    })
    await vectorizeMemory(this.repo, this.embedder, this.opts.channelId, this.opts.agentId, dedupKey, input.content)
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
      sessionId: task.sessionId ?? '',
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
      sessionId: (msg.metadata?.['x-aw-session-id'] as string | undefined) ?? '',
      dedupKey: `peer:${msg.messageId}`,
    })
    await this.vectorize(content, `peer:${msg.messageId}`)
  }

  /** 写入后向量化(委托模块级 vectorizeMemory;未切分原文,失败静默留 FTS) */
  protected async vectorize(plainContent: string, dedupKey: string): Promise<void> {
    await vectorizeMemory(this.repo, this.embedder, this.opts.channelId, this.opts.agentId, dedupKey, plainContent)
  }

  // ===== 上下文治理/团队历史(P0-3 新增写入面;全部幂等 upsert)=====
}
