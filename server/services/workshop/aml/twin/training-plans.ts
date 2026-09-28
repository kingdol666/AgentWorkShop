/**
 * AML 建模任务(Training Plans)—— 训练与优化解耦的编排核心(2026-09-26 计划 v3)。
 *
 * 职责:AML 管理界面/训练 Channel 创建「建模任务」(绑定 line/product/recipe + 数据集
 * IO 契约 + 固化训练 spec);worker 检测新批次 → 重建数据集(历史+新批次=修正训练)
 * → submitJob(平台参考训练器,实验谱系串联)→ concludeJob 钩子回写状态与模型 id。
 * 模型入册后由 AML 界面绑定到工艺优化 Channel(绑定校验在 channel-profile.ts)。
 */
import { createId } from './contracts'
import { getAmlRuntime } from '../runtime'
import { parseDatasetSpec, type AmlDatasetSpec } from '../spec'
import { buildDataset } from '../dataset-builder'
import { submitJob } from '../job-orchestrator/submit'
import { getDcwController } from '../../dcw/dcw-controller'

export interface AmlTrainingPlanRow {
  id: string
  name: string
  lineId: string
  productId: string
  recipeId: string
  sceneId?: string
  sceneVersion?: string
  objectiveId?: string
  purpose: string
  strategy: 'auto' | 'manual'
  datasetSpecJson: string
  trainingSpecJson?: string
  modelNamePrefix: string
  paramsJson: string
  seed?: number
  minIntervalSec: number
  lastRunCount: number
  lastJobId?: string
  lastDatasetId?: string
  lastModelId?: string
  lastStatus: 'idle' | 'training' | 'done' | 'failed'
  lastError?: string
  lastTrainedAt?: string
  enabled: number
  createdBy: string
  createdAt: string
  updatedAt: string
}

const COLS = 'id,name,line_id,product_id,recipe_id,scene_id,scene_version,objective_id,purpose,strategy,dataset_spec_json,training_spec_json,model_name_prefix,params_json,seed,min_interval_sec,last_run_count,last_job_id,last_dataset_id,last_model_id,last_status,last_error,last_trained_at,enabled,created_by,created_at,updated_at'

function rowOf(r: Record<string, unknown>): AmlTrainingPlanRow {
  return {
    id: String(r.id), name: String(r.name), lineId: String(r.line_id), productId: String(r.product_id), recipeId: String(r.recipe_id),
    sceneId: r.scene_id ? String(r.scene_id) : undefined, sceneVersion: r.scene_version ? String(r.scene_version) : undefined,
    objectiveId: r.objective_id ? String(r.objective_id) : undefined,
    purpose: String(r.purpose), strategy: r.strategy === 'manual' ? 'manual' : 'auto',
    datasetSpecJson: String(r.dataset_spec_json ?? '{}'), trainingSpecJson: r.training_spec_json ? String(r.training_spec_json) : undefined,
    modelNamePrefix: String(r.model_name_prefix ?? 'AML 自动训练模型'), paramsJson: String(r.params_json ?? '{}'),
    seed: r.seed != null ? Number(r.seed) : undefined,
    minIntervalSec: Number(r.min_interval_sec ?? 3600), lastRunCount: Number(r.last_run_count ?? 0),
    lastJobId: r.last_job_id ? String(r.last_job_id) : undefined, lastDatasetId: r.last_dataset_id ? String(r.last_dataset_id) : undefined,
    lastModelId: r.last_model_id ? String(r.last_model_id) : undefined,
    lastStatus: (['idle', 'training', 'done', 'failed'].includes(String(r.last_status)) ? String(r.last_status) : 'idle') as AmlTrainingPlanRow['lastStatus'],
    lastError: r.last_error ? String(r.last_error) : undefined, lastTrainedAt: r.last_trained_at ? String(r.last_trained_at) : undefined,
    enabled: Number(r.enabled ?? 1), createdBy: String(r.created_by ?? ''), createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  }
}

function db() {
  return getAmlRuntime().db
}

export function listTrainingPlans(): AmlTrainingPlanRow[] {
  return (db().prepare(`SELECT ${COLS} FROM aml_training_plans ORDER BY created_at DESC`).all() as Array<Record<string, unknown>>).map(rowOf)
}

export function getTrainingPlan(id: string): AmlTrainingPlanRow | undefined {
  const r = db().prepare(`SELECT ${COLS} FROM aml_training_plans WHERE id = ?`).get(id) as Record<string, unknown> | undefined
  return r ? rowOf(r) : undefined
}

export function createTrainingPlan(input: {
  name: string
  lineId: string
  productId: string
  recipeId: string
  sceneId?: string
  sceneVersion?: string
  objectiveId?: string | null
  purpose?: string
  strategy?: 'auto' | 'manual'
  datasetSpec: AmlDatasetSpec
  trainingSpec?: Record<string, unknown>
  modelNamePrefix?: string
  params?: Record<string, unknown>
  seed?: number
  minIntervalSec?: number
  createdBy?: string
}): AmlTrainingPlanRow {
  const parsed = parseDatasetSpec(input.datasetSpec)
  const id = createId('aml-plan')
  const now = new Date().toISOString()
  db().prepare(`INSERT INTO aml_training_plans(${COLS}) VALUES(${COLS.split(',').map(() => '?').join(',')})`)
    .run(id, String(input.name ?? '').slice(0, 120) || `建模任务 ${id.slice(-6)}`, input.lineId, input.productId, input.recipeId,
      input.sceneId ?? null, input.sceneVersion ?? null, input.objectiveId ?? null,
      input.purpose === 'quality_predict' ? 'quality_predict' : 'mpc_surrogate',
      input.strategy === 'manual' ? 'manual' : 'auto',
      JSON.stringify(parsed), input.trainingSpec ? JSON.stringify(input.trainingSpec) : null,
      String(input.modelNamePrefix ?? 'AML 自动训练模型').slice(0, 80), JSON.stringify(input.params ?? {}), input.seed ?? null,
      Math.max(60, Number(input.minIntervalSec ?? 3600)), 0, null, null, null, 'idle', null, null,
      input.strategy === 'manual' ? 0 : 1, input.createdBy ?? 'system', now, now)
  return getTrainingPlan(id)!
}

export function updateTrainingPlan(id: string, patch: {
  name?: string
  strategy?: 'auto' | 'manual'
  trainingSpec?: Record<string, unknown> | null
  objectiveId?: string | null
  minIntervalSec?: number
  enabled?: boolean
  lastModelId?: string
}): AmlTrainingPlanRow {
  const prev = getTrainingPlan(id)
  if (!prev) throw new Error(`建模任务不存在:${id}`)
  const sets: string[] = []
  const vals: Array<string | number | null> = []
  if (patch.name !== undefined) {
    sets.push('name=?')
    vals.push(String(patch.name).slice(0, 120))
  }
  if (patch.strategy !== undefined) {
    sets.push('strategy=?')
    vals.push(patch.strategy)
  }
  if (patch.trainingSpec !== undefined) {
    sets.push('training_spec_json=?')
    vals.push(patch.trainingSpec === null ? null : JSON.stringify(patch.trainingSpec))
  }
  if (patch.objectiveId !== undefined) {
    sets.push('objective_id=?')
    vals.push(patch.objectiveId ?? null)
  }
  if (patch.minIntervalSec !== undefined) {
    sets.push('min_interval_sec=?')
    vals.push(Math.max(60, Number(patch.minIntervalSec)))
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled=?')
    vals.push(patch.enabled ? 1 : 0)
  }
  if (patch.lastModelId !== undefined) {
    sets.push('last_model_id=?')
    vals.push(patch.lastModelId ?? null)
  }
  if (sets.length === 0) return prev
  sets.push('updated_at=?')
  vals.push(new Date().toISOString())
  vals.push(id)
  db().prepare(`UPDATE aml_training_plans SET ${sets.join(', ')} WHERE id=?`).run(...vals)
  return getTrainingPlan(id)!
}

export function deleteTrainingPlan(id: string): boolean {
  return db().prepare('DELETE FROM aml_training_plans WHERE id=?').run(id).changes > 0
}

/** 该产线+配方的已完结批次数(新批次检测基数) */
function completedRunCount(lineId: string, recipeId: string): number {
  try {
    return getDcwController().listRuns().filter(r => r.lineId === lineId && (!r.recipeId || r.recipeId === recipeId) && r.endedAt).length
  }
  catch {
    try {
      return getDcwController().listRuns().filter(r => r.lineId === lineId && r.recipeId === recipeId).length
    }
    catch {
      return 0
    }
  }
}

/**
 * 触发一次建模任务的修正训练:
 * 数据集重建(不传 runIds → 全部已完结批次,自动纳入探索 Channel 产的新批次)
 * → submitJob(hybrid_residual,固化 spec)→ plan 状态回写。spec 未固化的 plan 拒绝
 * (须先由训练 Channel 的 draft 流程生成后 PATCH 到 plan)。
 */
export async function runPlanTraining(planId: string, by: { id: string, kind: 'user' | 'agent' }): Promise<{ jobId: string, datasetId: string, rowCount: number }> {
  const plan = getTrainingPlan(planId)
  if (!plan) throw new Error(`建模任务不存在:${planId}`)
  if (!plan.trainingSpecJson) throw new Error('建模任务尚未固化训练 spec(先在训练 Channel 完成 draft 流程,或由界面导入);拒绝训练。')
  const spec = parseDatasetSpec(JSON.parse(plan.datasetSpecJson))
  const built = await buildDataset(spec, by)
  const dataset = built.dataset
  const trainingSpec = JSON.parse(plan.trainingSpecJson) as Record<string, unknown> & { modelId?: string }
  const providerId = String(trainingSpec.modelId ?? '')
  if (!providerId) throw new Error('训练 spec 缺少 modelId(providerId),拒绝提交。')
  const params = (() => {
    try {
      return JSON.parse(plan.paramsJson || '{}') as Record<string, unknown>
    }
    catch {
      return {}
    }
  })()
  const job = submitJob({
    datasetId: dataset.id,
    purpose: plan.purpose === 'quality_predict' ? 'quality_predict' : 'mpc_surrogate',
    changeNote: `建模任务 ${plan.name}:修正训练(批次基数 ${plan.lastRunCount}→${completedRunCount(plan.lineId, plan.recipeId)})`,
    params,
    seed: plan.seed ?? 7,
    jobKind: 'hybrid_residual',
    sceneId: plan.sceneId ?? undefined,
    sceneVersion: plan.sceneVersion ?? undefined,
    objectiveId: plan.objectiveId ?? undefined,
    physicsSpec: trainingSpec,
    providerId,
    providerVersion: '1.0.0',
    providerHash: `sha256:${JSON.stringify(trainingSpec).length}`,
    modelName: `${plan.modelNamePrefix}`,
    modelDescription: `建模任务 ${plan.id} 自动训练;产线 ${plan.lineId}/配方 ${plan.recipeId}${plan.objectiveId ? `;目标 ${plan.objectiveId}` : ''};数据集 ${dataset.id}(${dataset.rowCount} 行)`,
    agent: by.kind === 'agent' ? { id: by.id } : undefined,
  })
  const now = new Date().toISOString()
  db().prepare('UPDATE aml_training_plans SET last_job_id=?, last_dataset_id=?, last_status=?, last_run_count=?, last_trained_at=?, last_error=NULL, updated_at=? WHERE id=?')
    .run(job.id, dataset.id, 'training', completedRunCount(plan.lineId, plan.recipeId), now, now, planId)
  return { jobId: job.id, datasetId: dataset.id, rowCount: dataset.rowCount }
}

/** worker tick:检测新批次并自动触发(auto 策略 + 到达最短间隔 + 批次数增长) */
export async function processTrainingPlans(): Promise<Array<{ planId: string, jobId: string }>> {
  const triggered: Array<{ planId: string, jobId: string }> = []
  for (const plan of listTrainingPlans()) {
    try {
      if (!plan.enabled || plan.strategy !== 'auto') continue
      if (plan.lastStatus === 'training') continue
      if (plan.lastTrainedAt && Date.parse(plan.lastTrainedAt) + plan.minIntervalSec * 1000 > Date.now()) continue
      const runs = completedRunCount(plan.lineId, plan.recipeId)
      if (runs <= plan.lastRunCount) continue
      if (!plan.trainingSpecJson) continue
      const r = await runPlanTraining(plan.id, { id: 'system:training-planner', kind: 'agent' })
      triggered.push({ planId: plan.id, jobId: r.jobId })
    }
    catch (err) {
      db().prepare('UPDATE aml_training_plans SET last_status=?, last_error=?, updated_at=? WHERE id=?')
        .run('failed', err instanceof Error ? err.message.slice(0, 400) : String(err).slice(0, 400), new Date().toISOString(), plan.id)
    }
  }
  return triggered
}

/** concludeJob 钩子:训练终态回写 plan(按 job 的 budget.planId 关联) */
export function settleTrainingPlanByJob(jobId: string, status: 'done' | 'failed', modelId?: string, error?: string): void {
  try {
    const rows = db().prepare('SELECT id FROM aml_training_plans WHERE last_job_id = ?').all(jobId) as Array<{ id: string }>
    for (const row of rows) {
      db().prepare('UPDATE aml_training_plans SET last_status=?, last_model_id=COALESCE(?, last_model_id), last_error=?, updated_at=? WHERE id=?')
        .run(status, modelId ?? null, status === 'failed' ? (error ?? 'training failed').slice(0, 400) : null, new Date().toISOString(), row.id)
    }
  }
  catch { /* 单测/表未建:静默 */ }
}
