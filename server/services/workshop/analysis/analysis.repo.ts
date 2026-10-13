/**
 * 数据分析系统 · 分析报告台账(analysis_reports)。
 *
 * 定位:Agent Channel 分析产出的持久留痕 —— append-only,工具面只提供 save/query,
 * 无更新与删除(删仅 REST admin 面)。产线/配方/时间/关键结论为一级字段;
 * 归因(channel/actor)与产线上下文在保存时快照固化,产线改名或删除后历史仍可读。
 *
 * 头注释铁律同 aml.repo:全部参数绑定(无字符串拼 SQL;LIKE 的 % 也在参数侧)。
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

export interface AnalysisReportRow {
  id: string
  lineId: string
  lineName: string
  title: string
  category: string
  /** 一句话关键结论(列表面展示) */
  summary: string
  /** 关键结论数组(结构化发现) */
  conclusions: string[]
  /** 完整分析正文(markdown) */
  report: string
  /** 支撑指标/数据 */
  metrics: Record<string, unknown>
  recipeId: string
  recipeVersion: string
  /** 分析的数据时间窗(ISO;空 = 未指明) */
  windowFrom: string | null
  windowTo: string | null
  /** 证据来源说明(daq 窗口/mes 数据集/批次号等,人读) */
  dataSources: string
  /** 保存时的产线上下文快照(产品/批次/控制模式等) */
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
}

export interface AnalysisReportInput {
  id: string
  lineId: string
  lineName: string
  title: string
  category: string
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
}

export interface AnalysisReportFilter {
  /** 作用域限制(可见产线集合;空 = 不限) */
  lineIds?: string[]
  lineId?: string
  recipeId?: string
  category?: string
  /** 关键词(title/summary LIKE) */
  q?: string
  /** created_at 下/上界(ISO) */
  from?: string
  to?: string
  limit?: number
}

const COLS = `id, line_id AS lineId, line_name AS lineName, title, category, summary,
  conclusions_json AS conclusionsJson, report, metrics_json AS metricsJson,
  recipe_id AS recipeId, recipe_version AS recipeVersion,
  window_from AS windowFrom, window_to AS windowTo, data_sources AS dataSources,
  context_json AS contextJson, channel_id AS channelId, channel_name AS channelName,
  actor, actor_name AS actorName, created_at AS createdAt,
  updated_at AS updatedAt, updated_by AS updatedBy, updated_by_name AS updatedByName`

function rowToReport(r: Record<string, unknown>): AnalysisReportRow {
  const parseJson = (raw: unknown, dflt: unknown): unknown => {
    try {
      return JSON.parse(String(raw ?? '')) ?? dflt
    }
    catch {
      return dflt
    }
  }
  return {
    ...(r as unknown as Omit<AnalysisReportRow, 'conclusions' | 'metrics' | 'context' | 'conclusionsJson' | 'metricsJson' | 'contextJson'>),
    conclusions: parseJson(r.conclusionsJson, []) as string[],
    metrics: parseJson(r.metricsJson, {}) as Record<string, unknown>,
    context: parseJson(r.contextJson, {}) as Record<string, unknown>,
  } as AnalysisReportRow
}

export function createAnalysisRepo(db: DatabaseSync) {
  const insertStmt = db.prepare(
    `INSERT INTO analysis_reports (id, line_id, line_name, title, category, summary,
       conclusions_json, report, metrics_json, recipe_id, recipe_version,
       window_from, window_to, data_sources, context_json,
       channel_id, channel_name, actor, actor_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  // v27 人工修订:读改写单条全量 UPDATE(patch 在调用方合并,语句一次 prepare)
  const updateStmt = db.prepare(
    `UPDATE analysis_reports SET title = ?, category = ?, summary = ?, conclusions_json = ?,
       report = ?, metrics_json = ?, recipe_id = ?, recipe_version = ?,
       window_from = ?, window_to = ?, data_sources = ?,
       updated_at = ?, updated_by = ?, updated_by_name = ?
     WHERE id = ?`,
  )
  const getStmt = db.prepare(`SELECT ${COLS} FROM analysis_reports WHERE id = ?`)
  const removeStmt = db.prepare(`DELETE FROM analysis_reports WHERE id = ?`)
  const countStmt = db.prepare('SELECT COUNT(*) AS c FROM analysis_reports')

  return {
    insert(row: AnalysisReportInput): void {
      insertStmt.run(
        row.id, row.lineId, row.lineName, row.title, row.category, row.summary,
        JSON.stringify(row.conclusions ?? []), row.report ?? '', JSON.stringify(row.metrics ?? {}),
        row.recipeId ?? '', row.recipeVersion ?? '',
        row.windowFrom ?? null, row.windowTo ?? null, row.dataSources ?? '', JSON.stringify(row.context ?? {}),
        row.channelId ?? '', row.channelName ?? '', row.actor ?? '', row.actorName ?? '', row.createdAt,
      )
    },
    get(id: string): AnalysisReportRow | undefined {
      const r = getStmt.get(id) as Record<string, unknown> | undefined
      return r ? rowToReport(r) : undefined
    },
    list(filter: AnalysisReportFilter = {}): AnalysisReportRow[] {
      const where: string[] = []
      const args: SQLInputValue[] = []
      if (filter.lineId) {
        where.push('line_id = ?')
        args.push(filter.lineId)
      }
      if (filter.lineIds && filter.lineIds.length > 0) {
        where.push(`line_id IN (${filter.lineIds.map(() => '?').join(', ')})`)
        args.push(...filter.lineIds)
      }
      if (filter.recipeId) {
        where.push('recipe_id = ?')
        args.push(filter.recipeId)
      }
      if (filter.category) {
        where.push('category = ?')
        args.push(filter.category)
      }
      if (filter.q) {
        // 关键词三列 LIKE:标题 / 一句话结论 / 结论明细(JSON 数组文本,元素原串可命中)
        where.push('(title LIKE ? OR summary LIKE ? OR conclusions_json LIKE ?)')
        const like = `%${filter.q}%`
        args.push(like, like, like)
      }
      if (filter.from) {
        where.push('created_at >= ?')
        args.push(filter.from)
      }
      if (filter.to) {
        where.push('created_at <= ?')
        args.push(filter.to)
      }
      const sql = `SELECT ${COLS} FROM analysis_reports ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC LIMIT ?`
      args.push(Math.min(500, Math.max(1, filter.limit ?? 100)))
      return (db.prepare(sql).all(...args) as unknown as Record<string, unknown>[]).map(rowToReport)
    },
    remove(id: string): boolean {
      return Number(removeStmt.run(id).changes) > 0
    },
    /**
     * v27 人工修订:部分字段更新(patch 缺省 = 保留原值),固化修订归因。
     * 编辑面属人类管理操作(Agent 面仍无改删);调用方负责权限校验与窗口归一。
     */
    update(id: string, patch: {
      title?: string
      category?: string
      summary?: string
      conclusions?: string[]
      report?: string
      metrics?: Record<string, unknown>
      recipeId?: string
      recipeVersion?: string
      windowFrom?: string | null
      windowTo?: string | null
      dataSources?: string
    }, editor: { id: string, name: string }): AnalysisReportRow | undefined {
      const cur = getStmt.get(id) as Record<string, unknown> | undefined
      if (!cur) return undefined
      const merged = rowToReport(cur)
      updateStmt.run(
        patch.title !== undefined ? patch.title : merged.title,
        patch.category !== undefined ? patch.category : merged.category,
        patch.summary !== undefined ? patch.summary : merged.summary,
        JSON.stringify(patch.conclusions !== undefined ? patch.conclusions : merged.conclusions),
        patch.report !== undefined ? patch.report : merged.report,
        JSON.stringify(patch.metrics !== undefined ? patch.metrics : merged.metrics),
        patch.recipeId !== undefined ? patch.recipeId : merged.recipeId,
        patch.recipeVersion !== undefined ? patch.recipeVersion : merged.recipeVersion,
        patch.windowFrom !== undefined ? patch.windowFrom : merged.windowFrom,
        patch.windowTo !== undefined ? patch.windowTo : merged.windowTo,
        patch.dataSources !== undefined ? patch.dataSources : merged.dataSources,
        new Date().toISOString(),
        editor.id,
        editor.name,
        id,
      )
      return this.get(id)
    },
    count(): number {
      return Number((countStmt.get() as { c: number }).c)
    },
  }
}

export type AnalysisRepo = ReturnType<typeof createAnalysisRepo>

let singleton: AnalysisRepo | null = null

/** Nitro 插件启动时装配(plugins/workshop.ts) */
export function configureAnalysisRepo(db: DatabaseSync): void {
  singleton = createAnalysisRepo(db)
}

/** 运行期取用(未装配即抛 = 装配漏接线的响亮失败) */
export function getAnalysisRepo(): AnalysisRepo {
  if (!singleton) throw new Error('analysis repo 未装配(configureAnalysisRepo 未调用)')
  return singleton
}
