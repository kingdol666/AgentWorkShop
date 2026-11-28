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
  opts: { limit?: number, timeBudgetMs?: number, rebuild?: boolean, provider?: ReturnType<typeof getEmbeddingProvider> } = {},
): Promise<BackfillResult> {
  const provider = opts.provider ?? getEmbeddingProvider()
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

  // 候选扫描：rowid 游标翻页（评审发现 3/4，2026-11-28）。旧实现按 updated_at 固定窗口 +
  // pending 空即报 0：rebuild 时 vecSet 不更新主表 updated_at → 每轮原地重编同一批；
  // eligible > 窗口且窗口内全有向量 → 窗口外行永远不回填。现在按 rowid 升序翻页，
  // pending 稀缺时游标前移继续找，直到预算/条数/表尾。
  const windowRows = Math.max(limit * 8, 2000)
  const maxWindows = 64
  let cursor = 0
  let scanned = 0
  let embedded = 0
  let failed = 0
  const windowStmt = db.prepare(
    `SELECT rowid, id, agent_id, title, content FROM agent_memories
      WHERE deleted_at IS NULL AND COALESCE(status, 'active') != 'retired' AND rowid > ?
      ORDER BY rowid LIMIT ?`,
  )
  for (let w = 0; w < maxWindows; w++) {
    if (Date.now() - started > budget || embedded >= limit) break
    const candidates = windowStmt.all(cursor, windowRows) as unknown as CandidateRow[]
    if (candidates.length === 0) break
    scanned += candidates.length
    cursor = Number(candidates[candidates.length - 1]!.rowid)
    for (const row of candidates) {
      if (embedded >= limit || Date.now() - started > budget) break
      if (!opts.rebuild && have.has(Number(row.rowid))) continue
      try {
        const [vec] = await provider.embed([embedText(row)])
        if (!vec || vec.length !== dims) {
          failed++
          continue
        }
        repo.vecSet(Number(row.rowid), row.agent_id, vec)
        have.add(Number(row.rowid))
        embedded++
      }
      catch {
        failed++
      }
    }
  }

  // 剩余量：以"可编码行数 − 现有向量行数"为准（不依赖本批 pending——游标可能停在
  // "本批已满"而表里仍有未编行，调用方按 remaining 继续调用）。向量行可能多于可编码行
  // （孤儿/退休残留），故取 max(0,·)。
  const eligible = Number((db.prepare(
    `SELECT COUNT(*) AS n FROM agent_memories WHERE deleted_at IS NULL AND COALESCE(status, 'active') != 'retired'`,
  ).get() as { n: number }).n)
  const vectorRows = countVecRows(db)
  const remaining = Math.max(0, eligible - vectorRows)
  const model = provider.describe?.().model ?? 'unknown'
  return {
    model,
    dims,
    scanned,
    embedded,
    failed,
    remaining,
    vectorRows,
    resetVec,
  }
}
