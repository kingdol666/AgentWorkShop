/**
 * 向量回填（2026-11-28）：切换/首次启用 embedding 模型后，把存量记忆重新编码进
 * `agent_memories_vec`。
 *
 * 语义边界：
 *  - 向量是派生索引，事实源是 `agent_memories` 正文（unsegmentCJK 还原后编码）；
 *  - 换模型 = 换向量空间：维度不同必须 vecReset（丢弃旧向量），同维度也建议全量
 *    重算（不同模型同维度但空间不同，混用会让 kNN 结果无意义）——因此本函数支持
 *    `rebuild=true` 强制重算；
 *  - 批处理 + 时间预算：调用方（API/UI）反复调用直到 remaining=0，避免一次请求
 *    长时间占用事件循环。
 */
import type { DatabaseSync } from 'node:sqlite'
import { createMemoryRepo, type MemoryRepo } from '../../db/memory.repo'
import { unsegmentCJK } from '../../runtime/memory/helpers'
import { getEmbeddingProvider } from '../../runtime/embedding-provider'

export interface BackfillResult {
  model: string
  dims: number
  scanned: number
  embedded: number
  failed: number
  remaining: number
  vectorRows: number
  resetVec: boolean
}

interface CandidateRow {
  rowid: number | bigint
  id: string
  agent_id: string
  title: string
  content: string
}

/** 向量编码的文本形态：标题 + 正文（正文截断，控制单条延迟） */
function embedText(row: Pick<CandidateRow, 'title' | 'content'>): string {
  const body = unsegmentCJK(String(row.content ?? '')).slice(0, 2000)
  return `${String(row.title ?? '')}\n${body}`.trim()
}

function countVecRows(db: DatabaseSync): number {
  try {
    return Number((db.prepare('SELECT COUNT(*) AS n FROM agent_memories_vec').get() as { n: number }).n)
  }
  catch {
    return 0
  }
}

/**
 * 回填一批（默认 64 条 / 25s 预算）。
 * rebuild=true：先清空向量层并按当前模型维度重建（换模型的正确姿势）。
 */
export async function backfillEmbeddings(
  db: DatabaseSync,
  opts: { limit?: number, timeBudgetMs?: number, rebuild?: boolean } = {},
): Promise<BackfillResult> {
  const provider = getEmbeddingProvider()
  if (!provider) throw new Error('未启用向量模型：请先在记忆中心下载并启用本地模型，或配置 Embedding 端点')
  const limit = Math.max(1, Math.min(512, opts.limit ?? 64))
  const budget = Math.max(1000, Math.min(120_000, opts.timeBudgetMs ?? 25_000))
  const started = Date.now()

  // 维度：本地模型静态已知；HTTP 端点需一次探测
  let dims = provider.dims()
  if (!dims) {
    const [probe] = await provider.embed(['dimension probe'])
    dims = probe?.length ?? provider.dims()
  }
  if (!dims) throw new Error('无法确定向量维度：embedding 服务未返回向量')

  const repo: MemoryRepo = createMemoryRepo(db)
  let resetVec = false
  if (opts.rebuild) {
    resetVec = repo.vecReset(dims)
  }
  else if (!repo.vecInit(dims)) {
    // 已有向量层维度不符 → 必须重建（旧向量与新空间不可比）
    resetVec = repo.vecReset(dims)
  }
  if (!repo.vecReady) throw new Error(`向量层初始化失败（维度 ${dims}）`)

  // 已编码行（vec0 辅助列 mem_rowid ↔ agent_memories.rowid）
  const have = new Set<number>()
  try {
    const rows = db.prepare('SELECT mem_rowid FROM agent_memories_vec').all() as Array<{ mem_rowid: number | bigint }>
    for (const r of rows) have.add(Number(r.mem_rowid))
  }
  catch { /* 空表/首次建表：无既有向量 */ }

  // 候选窗口：一次取够（记忆表有条目上限，几千行量级），再在内存里按"是否已有向量"过滤。
  // 不用 OFFSET 分页：vec 是否存在无法在 SQL 侧与主表 join（vec0 虚拟表），窗口化最省心。
  const scanWindow = Math.max(limit * 8, 2000)
  const candidates = db.prepare(
    `SELECT rowid, id, agent_id, title, content FROM agent_memories
      WHERE deleted_at IS NULL AND COALESCE(status, 'active') != 'retired'
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?`,
  ).all(scanWindow) as unknown as CandidateRow[]

  const pending = candidates.filter(c => opts.rebuild || !have.has(Number(c.rowid))).slice(0, limit)
  let embedded = 0
  let failed = 0
  const model = provider.describe?.().model ?? 'unknown'
  for (const row of pending) {
    if (Date.now() - started > budget) break
    try {
      const [vec] = await provider.embed([embedText(row)])
      if (!vec || vec.length !== dims) {
        failed++
        continue
      }
      repo.vecSet(Number(row.rowid), row.agent_id, vec)
      embedded++
    }
    catch {
      failed++
    }
  }

  // 剩余量：以"可编码行数 − 现有向量行数"为准；本批没有待编码行时直接报 0
  // （否则调用方会对同一窗口空转）。向量行可能多于可编码行（孤儿/退休残留），故取 max(0,·)。
  const eligible = Number((db.prepare(
    `SELECT COUNT(*) AS n FROM agent_memories WHERE deleted_at IS NULL AND COALESCE(status, 'active') != 'retired'`,
  ).get() as { n: number }).n)
  const vectorRows = countVecRows(db)
  const remaining = pending.length === 0 ? 0 : Math.max(0, eligible - vectorRows)
  return {
    model,
    dims,
    scanned: candidates.length,
    embedded,
    failed,
    remaining,
    vectorRows,
    resetVec,
  }
}
