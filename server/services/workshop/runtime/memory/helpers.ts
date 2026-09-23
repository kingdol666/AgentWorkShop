/**
 * AgentMemory 的模块级纯工具/常量(原 server/services/workshop/runtime/memory.ts 类外声明,含类体之后与类无关的部分)。
 */
import type { MemoryRepo } from '../../db/memory.repo'
import type { MemoryRow } from '../../db/database'
import type { Part } from '../../types/a2a'
import type { EmbeddingProvider } from '../embedding-provider'
import { TEAM_AGENT_ID } from '../../db/memory.repo'
import { memorySettings } from '../../settings'

export const W_RELEVANCE = 0.5
export const W_RECENCY = 0.3
export const W_IMPORTANCE = 0.2
export const RECENT_FALLBACK = 5
export const MAX_TERMS = 12
/** CJK 单字词项上限(单字区分度低,12 个易主题漂移;ascii 词项仍取 MAX_TERMS) */
export const MAX_CJK_TERMS = 24
/** FTS 候选池深度(RRF 融合需要比最终引子更深的榜) */
export const FTS_POOL = 20
/** Reciprocal Rank Fusion 常数(业界标准 k=60) */
export const RRF_K = 60
/** MMR 多样性权重(λ×相关性 − (1−λ)×与已选集的最大相似) */
export const MMR_LAMBDA = 0.7
/** 任务关联加权:候选行 taskId ∈ 兄弟/父任务集时终分加成 */
export const RELATED_TASK_BOOST = 0.3
/** 策展层 kind(确定性 L0/按 key 直取;不进 L1 排名防双份注入,search_memory 仍可命中) */
export const CURATED_KINDS = new Set(['brief', 'chronicle', 'reflection'])
/** kind 感知时近衰减半衰期(天;0 = 不衰减) */
export const RECENCY_HALF_LIFE_DAYS: Record<string, number> = {
  'episodic-peer': 3,
  'episodic-task': 14,
  'episodic-session': 14,
  'episodic-team-task': 14,
  'semantic': 0,
  'brief': 0,
  'chronicle': 0,
  'reflection': 0,
}
export const CONTENT_STORE_LIMIT = 800

/** 环境变量安全数值(非有限/非正数 → fallback;防 NaN/0 破坏预算与定时器)。
 *  @deprecated 配置驱动迁移后仅存量测试使用;新代码读 memorySettings().*
 */
export function envNum(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** memory 组配置(单次解析,进程缓存;env AW_MEMORY_* 经 schema 描述符通用覆盖) */
export function memoryCfg() {
  return memorySettings()
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

export function partsText(parts: Part[]): string {
  return parts.map(p => ('text' in p ? p.text : '')).filter(Boolean).join('\n')
}

export function humanAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (Number.isNaN(ms)) return '?'
  if (ms < 60_000) return '刚刚'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}分钟前`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}小时前`
  return `${Math.floor(ms / 86_400_000)}天前`
}

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
  const expireDays = opts.expireDays ?? memoryCfg().expire_days
  const sessionExpireDays = memoryCfg().expire_session_days
  const cap = opts.cap ?? memoryCfg().cap
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

/** 写入后向量化(模块级;任务路径经 AgentMemory.vectorize,策展路径由 manager 直调)。
 *  ensure-vec → 定位行(dedupKey)→ embed(未切分原文,语义质量优先)→ vecSet;失败静默留 FTS。
 *
 *  放在 helpers 而非 facade:分层类要直接调用它,而 facade 依赖整条分层链 ——
 *  放 facade 会形成 层 → facade → 层 的循环导入。 */
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
