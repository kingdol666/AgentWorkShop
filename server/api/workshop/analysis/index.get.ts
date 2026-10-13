/**
 * GET /api/workshop/analysis —— 分析报告台账列表(线/配方/分类/关键词/时间窗过滤;产线可见性过滤)。
 */
import { getQuery } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { filterByLine } from '@/server/services/workshop/permissions'
import { getAnalysisRepo } from '@/server/services/workshop/analysis/analysis.repo'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const q = getQuery(event)
  const s = (k: string): string | undefined => (typeof q[k] === 'string' && q[k] ? (q[k] as string) : undefined)
  // 时间窗归一:列内 created_at 是本地时区 ISO(平台 toISOString 补丁),外部传入的
  // Z 格式/epoch ms 必须归一到同一文本形态,否则 SQL 文本比较错位
  const timeArg = (k: string): string | undefined => {
    const raw = s(k)
    if (!raw) return undefined
    const ms = /^\d{10,}$/.test(raw) ? Number(raw) : Date.parse(raw)
    return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
  }
  const rows = getAnalysisRepo().list({
    lineId: s('lineId'),
    recipeId: s('recipeId'),
    category: s('category'),
    q: s('q'),
    from: timeArg('from'),
    to: timeArg('to'),
    limit: Math.min(500, Math.max(1, Number(q.limit) || 100)),
  })
  const visible = filterByLine(user, rows, r => r.lineId || null)
  return { reports: visible, count: visible.length }
})
