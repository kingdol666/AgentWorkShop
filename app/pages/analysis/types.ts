/**
 * 数据分析页的类型面(与 server/services/workshop/analysis/analysis.repo.ts 的
 * AnalysisReportRow 驼峰投影一致;JSON 列已在服务端解析)。
 */

/** 分析类别(与 analysis_save 工具描述的建议档一致;自由面,未知类别按原文展示) */
export type AnalysisCategory = 'quality' | 'oee' | 'alarm' | 'trend' | 'optimization' | 'general'

export const ANALYSIS_CATEGORIES: AnalysisCategory[] = ['quality', 'oee', 'alarm', 'trend', 'optimization', 'general']

/** 时间窗预设(前端算 fromMs;all = 不限) */
export type AnalysisWindowPreset = '1h' | '24h' | '7d' | '30d' | 'all'

export const ANALYSIS_WINDOW_PRESETS: { key: AnalysisWindowPreset, ms: number | null }[] = [
  { key: '1h', ms: 3_600_000 },
  { key: '24h', ms: 86_400_000 },
  { key: '7d', ms: 7 * 86_400_000 },
  { key: '30d', ms: 30 * 86_400_000 },
  { key: 'all', ms: null },
]

export interface AnalysisReportView {
  id: string
  lineId: string
  lineName: string
  title: string
  category: string
  /** 一句话关键结论 */
  summary: string
  conclusions: string[]
  report: string
  metrics: Record<string, unknown>
  recipeId: string
  recipeVersion: string
  windowFrom: string | null
  windowTo: string | null
  dataSources: string
  context: Record<string, unknown>
  channelId: string
  channelName: string
  actor: string
  actorName: string
  createdAt: string
  /** v27 人工修订归因(未修订 = null/空) */
  updatedAt: string | null
  updatedBy: string
  updatedByName: string
  /** 编辑能力位(服务端按 admin/产线 operate 判定) */
  canEdit?: boolean
}
