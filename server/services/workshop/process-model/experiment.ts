/**
 * 参数试验计划(G2.11 / C9 / A9;P4 治理分档 2026-11-02):
 *  - simulated=true → tier=sim_auto,建计划即可执行(既有行为不变);
 *  - 真实线 → tier=real_hitl,创建后落 awaiting_approval,须 approveExperimentPlan
 *    单卡 HITL 批准(卡上带成本核算)后才能由 runExperimentPlan 执行;
 *  - 计划只落 process_model_experiments;动作明细仍走既有 DCW 写咽喉/台账
 *    (不制造第二套写设备账本)。
 */
import type { DatabaseSync } from 'node:sqlite'
import { AppError } from '../../../utils/errors'
import { getAmlRuntime } from '../aml/runtime'
import { getDcwLineRepo } from '../dcw/dcw-line.repo'
import { estimateExperimentCost, resolveExperimentTier, type ExperimentPlanBody, type ExperimentCost } from './experiment-runner'
import { assertPlanNodesSafe } from './plan-safety'

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
  /** MV → 观测目标节点(执行时读回;缺省不读) */
  targets?: Record<string, string>
  /** 已知主导扰动周期(ms;来自可辨识性引擎):成本核算按 3×周期给建议窗 */
  dominantPeriodMs?: number
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
  const tierInfo = resolveExperimentTier(input.lineId)
  if (!Object.keys(input.levels).length) throw new AppError(422, 'EXPERIMENT_PLAN_INVALID', '至少需要 1 个 MV 的水平序列')
  for (const [id, levels] of Object.entries(input.levels)) {
    if (!Array.isArray(levels) || levels.length < 2) throw new AppError(422, 'EXPERIMENT_PLAN_INVALID', `MV ${id} 至少需要 2 个水平(阶跃/多水平)`)
    if (levels.some(v => !Number.isFinite(v))) throw new AppError(422, 'EXPERIMENT_PLAN_INVALID', `MV ${id} 水平必须是有限数`)
    if (new Set(levels).size !== levels.length) throw new AppError(422, 'EXPERIMENT_PLAN_INVALID', `MV ${id} 水平重复`)
  }
  const repeats = Math.max(1, Math.min(input.repeats ?? 1, 20))
  const settleMs = Math.max(1000, input.settleMs ?? 60_000)
  const observeMs = Math.max(1000, input.observeMs ?? 120_000)
  // 上线前加固:真实线计划在**创建时**即校验节点归属(须属本线/启用/量程内,targets 须同线 DAQ)。
  // 仿真线计划允许用过程模型 MV 逻辑名(不落设备),创建不校验;执行时一律强校验(见 runner)。
  if (tierInfo.tier === 'real_hitl') {
    assertPlanNodesSafe({ lineId: input.lineId, levels: input.levels, targets: input.targets })
  }
  const db = getAmlRuntime().db
  const id = `pexp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const now = new Date().toISOString()
  // P4 成本前置:创建时就核算(真实线含 60s 写间隔下限;已知主导周期时按 3×周期建议窗)
  const cost: ExperimentCost = estimateExperimentCost(
    { levels: input.levels, repeats, settleMs, observeMs, tier: tierInfo.tier },
    { dominantPeriodMs: input.dominantPeriodMs ?? null },
  )
  const plan: ExperimentPlanBody = {
    version: 1,
    lineId: input.lineId,
    simSceneId: tierInfo.simSceneId ?? null,
    specId: input.specId ?? null,
    levels: input.levels,
    repeats,
    settleMs,
    observeMs,
    randomizedOrder: input.randomizedOrder !== false,
    abortOnAlarm: input.abortOnAlarm !== false,
    design: 'stepped_multi_level',
    tier: tierInfo.tier,
    ...(input.targets ? { targets: input.targets } : {}),
    cost,
    note: '动作明细经 DCW 写咽喉落 intervention_events([pexp:<id>] 前缀关联);本台账只保存计划与状态',
  }
  const budget = { maxRuns: input.budget?.maxRuns ?? Math.max(20, cost.steps), maxDurationMs: input.budget?.maxDurationMs ?? 4 * 3600_000 }
  db.prepare(`INSERT INTO process_model_experiments (id, line_id, plan_json, status, budget_json, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.lineId, JSON.stringify(plan), tierInfo.tier === 'real_hitl' ? 'awaiting_approval' : 'planned', JSON.stringify(budget), input.createdBy ?? '', now, now)
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
