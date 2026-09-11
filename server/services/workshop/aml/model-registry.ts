/**
 * AML 模型注册表:实验/模型登记 + 阶段流转(candidate → shadow → production → retired)。
 *
 * 治理:
 *  - 门禁全过的作业自动成为 candidate 实验并登记 candidate 模型(工件拷贝至 models/<id>/,不可变);
 *  - shadow/production 晋升必须经 HITL(调用方负责发审批;此处只做 SQL 层条件流转兜底并发);
 *  - 每 (product, recipe, purpose) 至多一个 production:晋升事务里同组旧 production 顺次 retired;
 *  - 候选/退役工件 GC 由 retention 扫描处理(注册表行永留,artifacts_pruned 标记缺文件)。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '../../../utils/errors'
import { recordOps } from '../ops/ops'
import { broadcastSceneEvent } from '../scene-events'
import { getAmlRuntime } from './runtime'
import type { AmlModelRow, AmlModelStage } from './aml.repo'
import type { GateReport } from './gates'

export type { AmlModelRow, AmlModelStage }

/** 作业终态时登记:门禁过 → candidate 模型;未过 → 仅实验行(gates_failed) */
export function registerModelFromJob(jobId: string, gates: GateReport, metricsJson: string): { experimentId: string, modelId?: string } {
  const rt = getAmlRuntime()
  const job = rt.repo.job.get(jobId)
  if (!job) throw new AppError(404, 'AML_JOB_MISSING', `作业 ${jobId} 不存在`)
  const dataset = rt.repo.dataset.get(job.datasetId)
  if (!dataset) throw new AppError(404, 'AML_DATASET_MISSING', `数据集 ${job.datasetId} 不存在`)

  const now = new Date().toISOString()
  const budget = job.budget as {
    seed?: number
    params?: Record<string, unknown>
    changeNote?: string
    parentExperimentId?: string | null
  }
  const expId = `exp-${jobId.slice(4)}`
  const existing = rt.repo.experiment.get(expId)
  if (!existing) {
    rt.repo.experiment.insert({
      id: expId,
      jobId,
      datasetId: job.datasetId,
      parentExperimentId: budget.parentExperimentId ?? null,
      changeNote: budget.changeNote ?? '',
      configJson: JSON.stringify({ purpose: job.purpose, params: budget.params ?? {}, agentId: job.agentId }),
      seed: budget.seed ?? null,
      createdAt: now,
    })
  }
  rt.repo.experiment.setResult(
    expId,
    metricsJson,
    JSON.stringify(gates),
    gates.passed ? 'gates_passed' : 'gates_failed',
  )
  if (!gates.passed) return { experimentId: expId }

  // 工件快照:artifacts → models/<modelId>/(不可变;注册表行指向这里)
  const modelId = `mdl-${jobId.slice(4)}`
  const modelDir = join(rt.modelsDir, modelId)
  if (!existsSync(modelDir)) {
    mkdirSync(modelDir, { recursive: true })
    cpSync(join(job.artifactsPath ?? join(rt.jobsDir, jobId, 'artifacts')), modelDir, { recursive: true })
    // io_spec 快照(预测服务的输入契约;norm 来自数据集 manifest,评估器已嵌入 metrics)
    writeFileSync(join(modelDir, 'REGISTERED'), now)
  }
  const ioSpec = buildIoSpec(dataset.path, job.purpose)
  // io_spec.json 同步落到模型实体目录:元数据行的 io_spec_json 是索引,实体自带契约
  // 才能让 ./aml 单独拷贝后仍可被预测服务装配(与 dataset 的 spec.json 同一范式)
  try {
    writeFileSync(join(modelDir, 'io_spec.json'), JSON.stringify(ioSpec, null, 2))
  }
  catch { /* 契约文件落盘失败不阻断注册(元数据行仍持有同一份) */ }
  rt.repo.model.insert({
    id: modelId,
    experimentId: expId,
    datasetId: job.datasetId,
    productId: dataset.productId,
    recipeId: dataset.recipeId,
    purpose: job.purpose,
    ioSpecJson: JSON.stringify(ioSpec),
    metricsJson,
    path: modelDir,
    createdBy: job.agentId || 'aml',
    note: gatesSummary(gates),
    createdAt: now,
  })
  recordOps({
    actor: job.agentId || 'aml', actorName: job.agentId || 'AML', actorKind: job.agentId ? 'agent' : 'system',
    action: 'aml.model.register', kind: 'system', summary: `候选模型 ${modelId} 登记(门禁通过)`,
    targetKind: 'aml_model', targetId: modelId,
    lineId: dataset.lineId, productId: dataset.productId, recipeId: dataset.recipeId,
  })
  return { experimentId: expId, modelId }
}

function gatesSummary(gates: GateReport): string {
  return gates.checks.map(c => `${c.id}:${c.pass ? '✓' : '✗'}${c.value != null ? `(${typeof c.value === 'number' ? c.value.toFixed(3) : c.value})` : ''}`).join(' ')
}

/** io_spec:从数据集 manifest 提取(预测服务的装配契约) */
function buildIoSpec(datasetPath: string, purpose: string): Record<string, unknown> {
  const manifest = JSON.parse(readFileSync(join(datasetPath, 'manifest.json'), 'utf8')) as {
    allNodes: string[]
    controlNodes: string[]
    targetNodes: string[]
    shapes: { x: [number, number, number], u: [number, number, number], y: [number, number, number] }
    norm: Record<string, { mean: number[], std: number[] }>
    beatMs: number
  }
  return {
    version: 1,
    purpose,
    modelInterface: 'one_step', // history[H,nAll](归一化) → y_next[nTgt](归一化)
    historySteps: manifest.shapes.x[1],
    horizonSteps: manifest.shapes.u[1],
    allNodes: manifest.allNodes,
    controlNodes: manifest.controlNodes,
    targetNodes: manifest.targetNodes,
    norm: manifest.norm,
    beatMs: manifest.beatMs,
    assumptions: 'rollout: control 取未来 U,feature 持最后观测(persistence),target 回填预测',
  }
}

export function parseIoSpec(model: AmlModelRow): ReturnType<typeof buildIoSpec> {
  return JSON.parse(model.ioSpecJson) as ReturnType<typeof buildIoSpec>
}

/**
 * 阶段流转(HITL 批准后调用):
 *  - candidate→shadow / shadow→production;production 晋升时同组旧 production 自动 retired。
 *  - 返回流转结果;SQL 条件更新兜底并发(他人已流转则失败)。
 */
export function transitionModel(modelId: string, toStage: Exclude<AmlModelStage, 'candidate'>, by: string, byKind: 'user' | 'agent' = 'user'): { ok: boolean, from?: AmlModelStage, retiredId?: string } {
  const rt = getAmlRuntime()
  const model = rt.repo.model.get(modelId)
  if (!model) throw new AppError(404, 'AML_MODEL_MISSING', `模型 ${modelId} 不存在`)
  const now = new Date().toISOString()
  const allowed: Record<string, AmlModelStage[]> = {
    shadow: ['candidate'],
    production: ['candidate', 'shadow'],
    retired: ['candidate', 'shadow', 'production'],
  }
  const from = allowed[toStage]
  if (!from?.includes(model.stage)) {
    throw new AppError(409, 'AML_STAGE_ILLEGAL', `不允许 ${model.stage} → ${toStage}`)
  }
  if (!rt.repo.model.transition(modelId, model.stage, toStage, by, now)) {
    throw new AppError(409, 'AML_STAGE_RACE', `模型已被并发流转(${model.stage} → ${toStage} 失败),请刷新后重试`)
  }
  let retiredId: string | undefined
  if (toStage === 'production') {
    // 同组旧 production 退役(新生产已生效,顺次让位;查询已排除本模型)
    for (const old of rt.repo.model.list({ stage: 'production', productId: model.productId, recipeId: model.recipeId, limit: 50 })) {
      if (old.id !== modelId && old.purpose === model.purpose) {
        rt.repo.model.transition(old.id, 'production', 'retired', by, now)
        retiredId = old.id
      }
    }
  }
  const dataset = rt.repo.dataset.get(model.datasetId)
  recordOps({
    actor: by, actorName: by, actorKind: byKind, action: 'aml.model.promote', kind: 'write',
    summary: `模型 ${modelId}: ${model.stage} → ${toStage}${retiredId ? `(旧生产 ${retiredId} 退役)` : ''}`,
    targetKind: 'aml_model', targetId: modelId,
    lineId: dataset?.lineId, productId: model.productId, recipeId: model.recipeId,
  })
  // WS:阶段流转实时帧(带 lineId 享逐 peer 过滤)
  broadcastSceneEvent('aml.model', {
    op: 'promoted', modelId, stage: toStage, from: model.stage,
    productId: model.productId, recipeId: model.recipeId, lineId: dataset?.lineId,
  })
  return { ok: true, from: model.stage, retiredId }
}
