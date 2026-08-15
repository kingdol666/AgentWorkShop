/**
 * AgentMemory — AgentRuntime 的持久记忆模块(harness 无关)。
 * MemGPT 分层(长期记忆落库+预算召回)/ Mem0 harvest(complete_task 自产摘要零 LLM 成本)/
 * agent-memory 排序装配(0.5×相关性+0.3×时近性+0.2×重要性,贪心预算)。
 * P1 注入 embedder 后 recall 升级混合检索;P0 纯 FTS。全部方法 async(async 签名 P0 定型)。
 */
import type { MemoryRepo } from '../db/memory.repo'
import type { MemoryRow } from '../db/database'
import type { WorkspaceTask } from '../types/task'
import type { A2AMessage, Part } from '../types/a2a'

const W_RELEVANCE = 0.5
const W_RECENCY = 0.3
const W_IMPORTANCE = 0.2
const RECENCY_DAYS = 7
const RECENT_FALLBACK = 5
const WEAK_HIT_KEEP = 3
const MAX_TERMS = 12
const CONTENT_STORE_LIMIT = 800

export interface AgentMemoryOptions {
  channelId: string
  agentId: string
  budgetTokens?: number
}

export interface RecallOptions {
  /** 默认 true;supervise 每 tick 调用应传 false 防 access_count 通胀 */
  touch?: boolean
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
  constructor(
    private repo: MemoryRepo,
    private opts: AgentMemoryOptions,
  ) {}

  /** run/supervise 前:混合检索+排序+预算装配 → 记忆块(null=无记忆不注入) */
  async recall(query: string, recallOpts: RecallOptions = {}): Promise<string | null> {
    const doTouch = recallOpts.touch !== false
    const budget = this.opts.budgetTokens ?? Number(process.env.AW_MEMORY_BUDGET_TOKENS ?? 800)
    const hits = new Map<string, { row: MemoryRow, relevance: number }>()

    const match = buildMatchQuery(query)
    if (match) {
      const found = this.repo.search(this.opts.agentId, match, MAX_TERMS)
      const first = found[0]
      const best = first ? Math.max(-first.bm25, 0.001) : 1
      found.forEach((row, i) => {
        const rel = Math.min(1, -row.bm25 / best)
        if (rel >= 0.1 || i < WEAK_HIT_KEEP) hits.set(row.id, { row, relevance: rel })
      })
    }
    for (const row of this.repo.listRecent(this.opts.agentId, RECENT_FALLBACK)) {
      if (!hits.has(row.id)) hits.set(row.id, { row, relevance: 0.15 })
    }
    if (hits.size === 0) return null

    const scored = [...hits.values()]
      .map(h => ({ ...h, score: this.score(h.row, h.relevance) }))
      .sort((a, b) => b.score - a.score)

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
    return [`## 相关记忆(本 Agent 历史作业沉淀;与当前任务冲突时,以当前任务为准)`, ...lines].join('\n')
  }

  /** run 后(任务路径;仅终态调用):harvest TaskEngine 终态 + deliverable */
  async recordTaskOutcome(task: WorkspaceTask): Promise<void> {
    const deliverable = task.artifacts
      .filter(a => a.name === 'deliverable' || a.name === 'summary')
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
    const content = row.content.length > 240 ? `${row.content.slice(0, 240)}…` : row.content
    return `- [${humanAgo(row.createdAt)}·${tag}] ${row.title}:${content}`
  }
}
