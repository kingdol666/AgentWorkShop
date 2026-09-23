/**
 * AgentMemoryLayer02 —— 写入:save / 任务结果 / peer 交换 / 向量化
 * (分层 3/5,承 AgentMemoryLayer01;方法体与原文件逐行一致)
 */
import { AgentMemoryLayer01 } from './01-recall'
import type { A2AMessage } from '../../types/a2a'
import type { WorkspaceTask } from '../../types/task'
import { CONTENT_STORE_LIMIT, partsText, segmentCJK, vectorizeMemory } from './helpers'
import { TEAM_AGENT_ID } from '../../db/memory.repo'
import { randomUUID } from 'node:crypto'

export abstract class AgentMemoryLayer02 extends AgentMemoryLayer01 {
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
  protected async vectorize(plainContent: string, dedupKey: string): Promise<void> {
    await vectorizeMemory(this.repo, this.embedder, this.opts.channelId, this.opts.agentId, dedupKey, plainContent)
  }

  // ===== 上下文治理/团队历史(P0-3 新增写入面;全部幂等 upsert)=====
}
