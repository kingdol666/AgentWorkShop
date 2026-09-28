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
import { getDcwLineRepo } from '../dcw/dcw-line.repo'
import { getDcwProductRepo } from '../dcw/dcw-product.repo'
import { getDcwRecipeRepo } from '../dcw/dcw-recipe.repo'
import { getAmlRuntime } from './runtime'
import type { AmlModelRow, AmlModelStage } from './aml.repo'
import type { GateReport } from './gates'

export type { AmlModelRow, AmlModelStage }

/** purpose 的人读目标词(优化目标未显式给 ObjectiveProfile 时的回退表达) */
const PURPOSE_GOAL_LABEL: Record<string, string> = {
  mpc_surrogate: 'MPC调参代理',
  quality_predict: '质量预测',
}

/**
 * 模型人读身份:label 必须让 Agent 与用户一眼看出 场景/产线·配方·优化目标。
 * 提交作业时的 model_name 作前缀(自拟短名),谱系尾由平台强制派生,不因命名而丢失区分度。
 */
function deriveModelIdentity(job: { budget: Record<string, unknown>, purpose: string }, dataset: { lineId: string, productId: string, recipeId: string }, modelId: string): { label: string, description: string, lineId: string, objectiveId: string } {
  const budget = job.budget as {
    modelName?: string
    modelDescription?: string
    sceneId?: string | null
    sceneVersion?: string | null
    objectiveId?: string | null
    jobKind?: string
  }
  const lineName = getDcwLineRepo().byId(dataset.lineId)?.name ?? dataset.lineId
  const productName = getDcwProductRepo().byId(dataset.productId)?.name ?? dataset.productId
  const recipeName = getDcwRecipeRepo().byId(dataset.recipeId)?.name ?? dataset.recipeId
  const goalLabel = budget.objectiveId
    ? `目标:${budget.objectiveId}`
    : (PURPOSE_GOAL_LABEL[job.purpose] ?? job.purpose)
  const sceneTag = budget.sceneId ? `${budget.sceneId}${budget.sceneVersion ? `@${budget.sceneVersion}` : ''}·` : ''
  const lineageTail = `${productName}/${recipeName}·${goalLabel}`
  const name = (budget.modelName ?? '').trim().slice(0, 80)
  const label = name ? `${name}(${lineageTail}) #${modelId.slice(-6)}` : `${sceneTag}${lineageTail} #${modelId.slice(-6)}`
  const description = (budget.modelDescription ?? '').trim().slice(0, 500) || [
    `产线 ${lineName}(${dataset.lineId})`,
    `产品 ${productName} · 配方 ${recipeName}`,
    `优化目标 ${budget.objectiveId ?? goalLabel}(purpose=${job.purpose})`,
    budget.sceneId ? `场景 ${sceneTag.replace(/·$/, '')}` : null,
    budget.jobKind && budget.jobKind !== 'supervised' ? `训练阶段 ${budget.jobKind}` : null,
  ].filter(Boolean).join(' | ')
  return { label, description, lineId: dataset.lineId, objectiveId: budget.objectiveId ?? '' }
}

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
    sceneId?: string
    sceneVersion?: string
    providerId?: string
    providerVersion?: string
    providerHash?: string
    providerGeneration?: number
  }
  let lineageMetrics = metricsJson
  try {
    const parsed = JSON.parse(metricsJson || '{}') as Record<string, unknown>
    if (budget.providerId || budget.providerVersion || budget.providerHash) {
      parsed.twinProvider = {
        providerId: budget.providerId ?? null,
        providerVersion: budget.providerVersion ?? null,
        providerHash: budget.providerHash ?? null,
        providerGeneration: budget.providerGeneration ?? null,
        sceneId: budget.sceneId ?? null,
        sceneVersion: budget.sceneVersion ?? null,
      }
      lineageMetrics = JSON.stringify(parsed)
    }
  }
  catch { /* retain platform metrics if lineage merge cannot parse */ }
  const expId = `exp-${jobId.slice(4)}`
  const existing = rt.repo.experiment.get(expId)
  if (!existing) {
    rt.repo.experiment.insert({
      id: expId,
      jobId,
      datasetId: job.datasetId,
      parentExperimentId: budget.parentExperimentId ?? null,
      changeNote: budget.changeNote ?? '',
      configJson: JSON.stringify({ purpose: job.purpose, params: budget.params ?? {}, agentId: job.agentId, providerId: budget.providerId ?? null, providerVersion: budget.providerVersion ?? null, providerHash: budget.providerHash ?? null, providerGeneration: budget.providerGeneration ?? null }),
      seed: budget.seed ?? null,
      createdAt: now,
    })
  }
  rt.repo.experiment.setResult(
    expId,
    lineageMetrics,
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
  const identity = deriveModelIdentity(job, dataset, modelId)
  rt.repo.model.insert({
    id: modelId,
    experimentId: expId,
    datasetId: job.datasetId,
    productId: dataset.productId,
    recipeId: dataset.recipeId,
    purpose: job.purpose,
    ioSpecJson: JSON.stringify(ioSpec),
    metricsJson: lineageMetrics,
    path: modelDir,
    createdBy: job.agentId || 'aml',
    note: gatesSummary(gates),
    label: identity.label,
    description: identity.description,
    lineId: identity.lineId,
    objectiveId: identity.objectiveId,
    createdAt: now,
  })
  recordOps({
    actor: job.agentId || 'aml', actorName: job.agentId || 'AML', actorKind: job.agentId ? 'agent' : 'system',
    action: 'aml.model.register', kind: 'system', summary: `候选模型 ${modelId} 登记(门禁通过)「${identity.label}」`,
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
  const modelMetrics = (() => {
    try {
      return JSON.parse(model.metricsJson || '{}') as Record<string, unknown>
    }
    catch {
      return {}
    }
  })()
  const twinProvider = modelMetrics.twinProvider as Record<string, unknown> | undefined
  const isHybridTwin = Boolean(twinProvider || modelMetrics.hybrid || modelMetrics.modelType === 'hybrid_physics_plus_residual' || modelMetrics.modelKind === 'hybrid_twin')
  if (isHybridTwin && toStage === 'production' && model.stage === 'candidate') {
    throw new AppError(409, 'AML_TWIN_SHADOW_REQUIRED', 'Hybrid Twin 模型禁止 candidate → production；必须先进入 shadow 并通过影子证据、UQ/OOD、SafetyCase 门禁')
  }
  if (isHybridTwin && toStage === 'production') {
    const eligibility = modelMetrics.twinEligibility as Record<string, unknown> | undefined
    if (eligibility?.recommendationEligible !== true || eligibility?.uqPassed !== true || eligibility?.oodPassed !== true || eligibility?.physicsPassed !== true) {
      throw new AppError(409, 'AML_TWIN_GATE_REQUIRED', 'Hybrid Twin production 晋升必须读取平台权威 Twin Gate 全部通过结果')
    }
    const shadow = modelMetrics.shadowEvidence as Record<string, unknown> | undefined
    if (shadow?.passed !== true) throw new AppError(409, 'AML_TWIN_SHADOW_EVIDENCE_REQUIRED', 'Hybrid Twin production 晋升缺少通过的 shadowEvidence')
  }
  const allowed: Record<string, AmlModelStage[]> = {
    shadow: ['candidate'],
    production: isHybridTwin ? ['shadow'] : ['candidate', 'shadow'],
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
