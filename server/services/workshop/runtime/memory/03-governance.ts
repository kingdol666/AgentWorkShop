/**
 * AgentMemoryLayer03 —— 上下文治理与团队历史(P0-3 幂等 upsert)
 * (分层 4/5,承 AgentMemoryLayer02;方法体与原文件逐行一致)
 */
import { AgentMemoryLayer02 } from './02-write'
import { CONTENT_STORE_LIMIT, segmentCJK, unsegmentCJK, vectorizeMemory } from './helpers'
import { TEAM_AGENT_ID } from '../../db/memory.repo'

/** §7.2 单条过程摘要的原文上限(800~1200 字口径;截断施加在**原文**上,再切分 CJK) */
const DIGEST_TEXT_LIMIT = 1_200

export abstract class AgentMemoryLayer03 extends AgentMemoryLayer02 {
  /** 会话压缩摘要序号(每实例自增;dedupKey 防同幂键覆盖) */
  protected sessionSeq = 0

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

  /**
   * 关键过程摘要(§7.1/§7.2):只记录状态/关键进度里程碑与 Lead 决策,
   * **不记录 token 流与每一次轮询**。dedupKey 由调用方提供,保证同一事件重复广播
   * 不会膨胀共享记忆。
   *
   * §7.2 摘要字段齐备:任务 / root / 事件 / 执行者 / 状态 / 结论 / artifact / 下一步 / 时间。
   * 长度策略:先按**原文**截到 1200 字(文档 800~1200 字口径),再切分 CJK —— 否则
   * segmentCJK 的插空格会让 800 字符 ≈ 267 汉字,实际可用内容只剩下限的 1/3。
   */
  async appendTeamTaskProgress(input: {
    taskId: string
    title: string
    event: string
    state: string
    assigneeId?: string
    progress?: number
    summary?: string
    dedupKey: string
    importance?: number
    /** §7.1 事件身份(root/child)与根任务归属 */
    eventType?: string
    nodeRole?: 'root' | 'child'
    rootId?: string
    rootTitle?: string
    artifact?: string
    nextStep?: string
    at?: string
  }): Promise<void> {
    const at = input.at ?? new Date().toISOString()
    const lines = [
      `任务：${input.title}`,
      input.rootId ? `根任务：${input.rootTitle || input.rootId.slice(0, 8)}(${input.rootId.slice(0, 8)})` : '',
      input.nodeRole ? `层级：${input.nodeRole === 'root' ? '根任务' : '子任务'}` : '',
      `事件：${input.event}${input.eventType ? `(${input.eventType})` : ''}`,
      `状态：${input.state}`,
      input.assigneeId ? `执行者：${input.assigneeId.slice(0, 8)}` : '',
      typeof input.progress === 'number' ? `进度：${input.progress}%` : '',
      input.summary ? `结论：${input.summary}` : '',
      input.artifact ? `交付物：${input.artifact}` : '',
      input.nextStep ? `下一步：${input.nextStep}` : '',
      `时间：${at}`,
    ].filter(Boolean)
    const plain = lines.join('；')
    const content = plain.length > DIGEST_TEXT_LIMIT ? `${plain.slice(0, DIGEST_TEXT_LIMIT)}…` : plain
    this.repo.upsert({
      channelId: this.opts.channelId,
      agentId: TEAM_AGENT_ID,
      kind: 'episodic-team-task',
      title: `${input.event} · ${input.title}`,
      titleFts: segmentCJK(`${input.event} ${input.title}`),
      content: segmentCJK(content).slice(0, CONTENT_STORE_LIMIT * 3),
      importance: input.importance ?? (input.state === 'COMPLETED' ? 0.8 : 0.6),
      taskId: input.taskId,
      dedupKey: input.dedupKey,
    })
    await vectorizeMemory(this.repo, this.embedder, this.opts.channelId, TEAM_AGENT_ID, input.dedupKey, plain)
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
}
