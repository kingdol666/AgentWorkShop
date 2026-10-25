/**
 * 模拟参数试验计划(G2.11 / C9 / A9):
 *  - 只有 simulated=true 的产线可发起;真实线 → SIM_ONLY_VIOLATION;
 *  - 计划只落 process_model_experiments;动作明细仍走既有 optimization_explorations/DCW 记录
 *    (不制造第二套写设备账本)。
 */
import type { DatabaseSync } from 'node:sqlite'
import { AppError } from '../../../utils/errors'
import { getAmlRuntime } from '../aml/runtime'
import { getDcwLineRepo } from '../dcw/dcw-line.repo'

export interface ExperimentPlanInput {
  lineId: string
  specId?: string
  /** MV → 水平序列(阶跃/多水平) */
  levels: Record<string, number[]>
  repeats?: number
  settleMs?: number
  observeMs?: number
  randomizedOrder?: boolean
  abortOnAlarm?: boolean
  budget?: { maxRuns?: number, maxDurationMs?: number }
  createdBy?: string
}

export interface ExperimentPlanRow {
  id: string
  lineId: string
  planJson: string
  status: string
  budgetJson: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

export function assertSimulatedLine(lineId: string): { id: string, simSceneId?: string } {
  const line = getDcwLineRepo().byId(lineId)
  if (!line) throw new AppError(404, 'LINE_NOT_FOUND', `产线 ${lineId} 不存在`)
  if (line.simulated !== true) {
    throw new AppError(422, 'SIM_ONLY_VIOLATION', `产线「${line.name}」不是模拟产线(simulated=false);禁止在其上发起模拟参数试验(真实线首阶段仅提供建议)`)
  }
  return { id: line.id, simSceneId: line.simSceneId }
}

export function createExperimentPlan(input: ExperimentPlanInput): ExperimentPlanRow {
  const line = assertSimulatedLine(input.lineId)
  if (!Object.keys(input.levels).length) throw new AppError(422, 'EXPERIMENT_PLAN_INVALID', '至少需要 1 个 MV 的水平序列')
  for (const [id, levels] of Object.entries(input.levels)) {
    if (!Array.isArray(levels) || levels.length < 2) throw new AppError(422, 'EXPERIMENT_PLAN_INVALID', `MV ${id} 至少需要 2 个水平(阶跃/多水平)`)
    if (levels.some(v => !Number.isFinite(v))) throw new AppError(422, 'EXPERIMENT_PLAN_INVALID', `MV ${id} 水平必须是有限数`)
    if (new Set(levels).size !== levels.length) throw new AppError(422, 'EXPERIMENT_PLAN_INVALID', `MV ${id} 水平重复`)
  }
  const repeats = Math.max(1, Math.min(input.repeats ?? 1, 20))
  const settleMs = Math.max(1000, input.settleMs ?? 60_000)
  const observeMs = Math.max(1000, input.observeMs ?? 120_000)
  const db = getAmlRuntime().db
  const id = `pexp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const now = new Date().toISOString()
  const plan = {
    version: 1,
    lineId: input.lineId,
    simSceneId: line.simSceneId ?? null,
    specId: input.specId ?? null,
    levels: input.levels,
    repeats,
    settleMs,
    observeMs,
    randomizedOrder: input.randomizedOrder !== false,
    abortOnAlarm: input.abortOnAlarm !== false,
    design: 'stepped_multi_level',
    note: '动作明细写入既有 optimization_explorations/DCW 账本;本台账只保存计划与状态',
  }
  const budget = { maxRuns: input.budget?.maxRuns ?? 20, maxDurationMs: input.budget?.maxDurationMs ?? 4 * 3600_000 }
  db.prepare(`INSERT INTO process_model_experiments (id, line_id, plan_json, status, budget_json, created_by, created_at, updated_at)
    VALUES (?, ?, ?, 'planned', ?, ?, ?, ?)`)
    .run(id, input.lineId, JSON.stringify(plan), JSON.stringify(budget), input.createdBy ?? '', now, now)
  return this_get(db, id)!
}

function this_get(db: DatabaseSync, id: string): ExperimentPlanRow | undefined {
  return db.prepare(`SELECT id, line_id AS lineId, plan_json AS planJson, status, budget_json AS budgetJson,
    created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt
    FROM process_model_experiments WHERE id = ?`).get(id) as unknown as ExperimentPlanRow | undefined
}

export function getExperimentPlan(id: string): ExperimentPlanRow | undefined {
  return this_get(getAmlRuntime().db, id)
}

export function listExperimentPlans(lineId?: string, limit = 50): ExperimentPlanRow[] {
  const db = getAmlRuntime().db
  return lineId
    ? db.prepare(`SELECT id, line_id AS lineId, plan_json AS planJson, status, budget_json AS budgetJson, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt FROM process_model_experiments WHERE line_id = ? ORDER BY created_at DESC LIMIT ?`).all(lineId, limit) as unknown as ExperimentPlanRow[]
    : db.prepare(`SELECT id, line_id AS lineId, plan_json AS planJson, status, budget_json AS budgetJson, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt FROM process_model_experiments ORDER BY created_at DESC LIMIT ?`).all(limit) as unknown as ExperimentPlanRow[]
}

export function updateExperimentStatus(id: string, status: 'planned' | 'running' | 'done' | 'cancelled' | 'failed'): void {
  getAmlRuntime().db.prepare('UPDATE process_model_experiments SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id)
}
