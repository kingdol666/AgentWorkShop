/* eslint-disable @stylistic/max-statements-per-line */
/**
 * 配方版本/工况谱系(process_context_segments)。
 *
 * 半开区间 [from_ts, to_ts);运行中切换拆段,训练窗口不得跨版本;
 * 只有仓库编辑事件(无"产线已应用"事件)时不拆段,只触发重校验。
 */
import type { DatabaseSync } from 'node:sqlite'
import { canonicalJson, sha256 } from '../aml/twin/contracts'
import { getAmlRuntime } from '../aml/runtime'

export interface ContextSegmentRow {
  id: string
  lineId: string
  runId: string
  fromTs: number
  toTs: number | null
  recipeId: string
  recipeVersion: number
  recipeContentHash: string
  conditionId: string
  source: 'line_run' | 'recipe_edit' | 'manual'
  confirmed: number
  createdAt: string
}

const COLS = `id, line_id AS lineId, run_id AS runId, from_ts AS fromTs, to_ts AS toTs,
  recipe_id AS recipeId, recipe_version AS recipeVersion, recipe_content_hash AS recipeContentHash,
  condition_id AS conditionId, source, confirmed, created_at AS createdAt`

/**
 * 配方内容 hash(C8 显式定义):
 *   paramsSnapshot + daqWindows + access + recipe.version + recipe.id
 * 稳定序列化后 sha256。不得声称等同于"整份配方定义"(不含 description/name 等展示字段)。
 */
export function recipeContentHash(recipe: {
  id: string
  version?: number
  params?: unknown
  daqWindows?: unknown
  access?: unknown
}, paramsSnapshot?: unknown): string {
  return sha256(canonicalJson({
    recipeId: recipe.id,
    version: recipe.version ?? 0,
    params: paramsSnapshot ?? recipe.params ?? [],
    daqWindows: recipe.daqWindows ?? [],
    access: recipe.access ?? null,
  }))
}

export function createContextSegmentRepo(db: DatabaseSync) {
  return {
    insert(input: Omit<ContextSegmentRow, 'id' | 'createdAt' | 'confirmed' | 'source'> & { source?: ContextSegmentRow['source'], confirmed?: boolean }): ContextSegmentRow {
      const id = `pcs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
      const now = new Date().toISOString()
      const source = input.source ?? 'line_run'
      const confirmed = input.confirmed ? 1 : 0
      db.prepare(`INSERT INTO process_context_segments
        (id, line_id, run_id, from_ts, to_ts, recipe_id, recipe_version, recipe_content_hash, condition_id, source, confirmed, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, from_ts) DO NOTHING`)
        .run(id, input.lineId, input.runId, input.fromTs, input.toTs, input.recipeId, input.recipeVersion, input.recipeContentHash, input.conditionId, source, confirmed, now)
      return this.getByRunFrom(input.runId, input.fromTs)!
    },

    getByRunFrom(runId: string, fromTs: number): ContextSegmentRow | undefined {
      return db.prepare(`SELECT ${COLS} FROM process_context_segments WHERE run_id = ? AND from_ts = ?`).get(runId, fromTs) as unknown as ContextSegmentRow | undefined
    },

    /** 关段:取该 run 未闭合的最新段 */
    close(runId: string, toTs: number): void {
      db.prepare(`UPDATE process_context_segments SET to_ts = ? WHERE run_id = ? AND to_ts IS NULL`).run(toTs, runId)
    },

    listByLine(lineId: string, fromTs?: number, toTs?: number): ContextSegmentRow[] {
      const where = ['line_id = ?']
      const args: Array<string | number> = [lineId]
      if (toTs != null) { where.push('from_ts < ?'); args.push(toTs) }
      if (fromTs != null) { where.push('(to_ts IS NULL OR to_ts > ?)'); args.push(fromTs) }
      return db.prepare(`SELECT ${COLS} FROM process_context_segments WHERE ${where.join(' AND ')} ORDER BY from_ts ASC`)
        .all(...(args as never[])) as unknown as ContextSegmentRow[]
    },

    /** 时间点归属段(半开区间)。 */
    at(lineId: string, tsMs: number): ContextSegmentRow | undefined {
      return db.prepare(`SELECT ${COLS} FROM process_context_segments WHERE line_id = ? AND from_ts <= ? AND (to_ts IS NULL OR to_ts > ?) ORDER BY from_ts DESC LIMIT 1`)
        .get(lineId, tsMs, tsMs) as unknown as ContextSegmentRow | undefined
    },
  }
}

export type ContextSegmentRepo = ReturnType<typeof createContextSegmentRepo>

const g = globalThis as typeof globalThis & { __processContextSegmentRepo?: ContextSegmentRepo }

export function getContextSegmentRepo(): ContextSegmentRepo {
  g.__processContextSegmentRepo ??= createContextSegmentRepo(getAmlRuntime().db)
  return g.__processContextSegmentRepo
}
