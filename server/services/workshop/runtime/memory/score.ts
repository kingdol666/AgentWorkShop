/**
 * AgentMemoryScore —— 打分与行格式化
 * (拆分层,承 AgentMemoryGovernance;方法体与原文件逐行一致)
 */
import { AgentMemoryGovernance } from './governance'
import type { MemoryRow } from '../../db/database'
import { RECENCY_HALF_LIFE_DAYS, W_IMPORTANCE, W_RECENCY, W_RELEVANCE, humanAgo, unsegmentCJK } from './helpers'

export abstract class AgentMemoryScore extends AgentMemoryGovernance {
  /** kind 感知综合分:时近衰减按 kind 半衰期(知识/策展层不随时间贬值) */
  protected score(row: MemoryRow, relevance: number): number {
    const halfLife = RECENCY_HALF_LIFE_DAYS[row.kind] ?? 7
    const ageDays = (Date.now() - Date.parse(row.createdAt)) / 86_400_000
    const recency = halfLife <= 0 ? 1 : Math.exp(-ageDays / halfLife)
    const importance = Math.min(1, row.importance + row.accessCount * 0.05)
    return W_RELEVANCE * relevance + W_RECENCY * recency + W_IMPORTANCE * importance
  }

  protected formatLine(row: MemoryRow): string {
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
