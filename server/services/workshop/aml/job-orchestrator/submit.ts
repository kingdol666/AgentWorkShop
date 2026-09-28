/**
 * 提交作业(参数校验 / 落库 / 启动)
 * (由 server/services/workshop/aml/job-orchestrator.ts 按职责拆出;内容逐行原文搬运)
 */
import type { AmlJobRow } from '../aml.repo'
import { AppError } from '../../../../utils/errors'
import { amlSettings } from '../../settings'
import { ensureTicker } from './control'
import { getAmlRuntime } from '../runtime'
import { recordOps } from '../../ops/ops'
import { state } from './shared'
import { wsJob } from './broadcast'
import { createTwinRepo } from '../twin/repo'
import { amlTwinFeatureFlags } from '../twin/feature-flags'

export interface SubmitJobInput {
  datasetId: string
  purpose?: 'mpc_surrogate' | 'quality_predict'
  parentExperimentId?: string | null
  changeNote?: string
  params?: Record<string, unknown>
  seed?: number
  trainFile?: string
  budget?: { maxExperiments?: number }
  /** 内联训练代码(REST 一次性提交;Agent 经 aml_job_submit 的 code 参数提交) */
  code?: string
  /** Hybrid Twin lineage context; kept in immutable budget_json for legacy schema compatibility. */
  sceneId?: string
  sceneVersion?: string
  objectiveId?: string
  jobKind?: 'supervised' | 'physics_calibration' | 'hybrid_residual' | 'uncertainty_calibration'
  physicsManifest?: Record<string, unknown>
  physicsSpec?: Record<string, unknown>
  twinSnapshot?: Record<string, unknown>
  objectiveProfile?: Record<string, unknown>
  providerId?: string
  providerVersion?: string
  providerHash?: string
  providerGeneration?: number
  /** 发起者;byKind 决定审计归属(actorKind) */
  agent?: { id: string, channelId?: string, taskId?: string }
  byKind?: 'user' | 'agent'
  /** 实验谱系:由重试等内部路径复用既有 experiment 行 */
  experimentId?: string
  /** 模型人读标识(注册时作 label 前缀;缺省由平台按 谱系·配方·目标 派生) */
  modelName?: string
  /** 建模意图描述(注册时落模型 description;缺省派生自谱系) */
  modelDescription?: string
}

export function submitJob(input: SubmitJobInput): AmlJobRow {
  const rt = getAmlRuntime()
  const s = amlSettings()
  const dataset = rt.repo.dataset.get(input.datasetId)
  if (!dataset) throw new AppError(404, 'AML_DATASET_MISSING', `数据集 ${input.datasetId} 不存在`)

  // Hybrid Twin 作业必须绑定已冻结的 SceneContract。场景发现/编译可以由 Agent 自动完成，
  // 但训练是不可逆的谱系写入，平台不能允许未确认 draft 进入校准或残差训练。
  const jobKind = input.jobKind ?? 'supervised'
  if (jobKind !== 'supervised' && !amlTwinFeatureFlags().trainingEnabled) throw new AppError(503, 'AML_TWIN_TRAINING_DISABLED', 'AML Twin 训练开关已关闭，拒绝提交物理校准/残差/UQ 作业')
  if (jobKind !== 'supervised') {
    if (!input.sceneId || !input.sceneVersion) throw new AppError(422, 'TWIN_SCENE_REQUIRED', 'Hybrid Twin 作业必须提供 sceneId 和 sceneVersion')
    const scene = createTwinRepo(rt.db).getScene(input.sceneId, input.sceneVersion)
    if (!scene) throw new AppError(404, 'TWIN_SCENE_MISSING', `SceneContract ${input.sceneId}@${input.sceneVersion} 不存在`)
    if (scene.status !== 'frozen') throw new AppError(409, 'TWIN_SCENE_NOT_FROZEN', `SceneContract ${input.sceneId}@${input.sceneVersion} 尚未冻结，禁止进入 ${jobKind}`)
    if (scene.lineId !== dataset.lineId || (scene.productId && scene.productId !== dataset.productId) || (scene.recipeId && scene.recipeId !== dataset.recipeId)) {
      throw new AppError(409, 'TWIN_SCENE_DATASET_MISMATCH', 'SceneContract 与 AML 数据集的 line/product/recipe 谱系不一致')
    }
    if (jobKind === 'hybrid_residual' && (!input.providerId || !input.providerVersion || !input.providerHash)) {
      throw new AppError(422, 'TWIN_PROVIDER_LINEAGE_REQUIRED', 'hybrid_residual 必须提供 providerId/providerVersion/providerHash')
    }
  }

  // 预算硬上限(ADR-3):单数据集实验数耗尽即拒绝,防 Agent 无限迭代
  const maxExperiments = input.budget?.maxExperiments ?? 12
  const used = rt.repo.experiment.countByDataset(input.datasetId)
  if (used >= maxExperiments) {
    throw new AppError(429, 'AML_BUDGET_EXHAUSTED', `该数据集实验预算已耗尽(${used}/${maxExperiments}):请审阅排行榜后决策,或提高 budget.maxExperiments`)
  }

  // 并发/排队上限:FIFO,防 Agent 无限刷队列
  const pending = state().queue.length
    + state().running.size
    + rt.repo.job.list({ status: 'queued' }).length
  if (pending >= 20) {
    throw new AppError(429, 'AML_QUEUE_FULL', `作业队列已满(${pending}),等待现有作业完成或取消排队作业`)
  }

  const byKind = input.byKind ?? (input.agent ? 'agent' : 'system')
  const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const now = new Date().toISOString()
  const row: AmlJobRow = {
    id,
    datasetId: input.datasetId,
    purpose: input.purpose ?? 'mpc_surrogate',
    status: 'queued',
    stage: '',
    progress: 0,
    budget: {
      maxExperiments,
      timeoutMs: s.job.timeoutMs,
      stallMs: s.job.stallMs,
      seed: input.seed ?? 42,
      params: input.params ?? {},
      changeNote: input.changeNote ?? '',
      parentExperimentId: input.parentExperimentId ?? null,
      inlineCode: input.code ?? null,
      byKind,
      sceneId: input.sceneId ?? null,
      sceneVersion: input.sceneVersion ?? null,
      objectiveId: input.objectiveId ?? null,
      jobKind,
      physicsManifest: input.physicsManifest ?? null,
      physicsSpec: input.physicsSpec ?? null,
      twinSnapshot: input.twinSnapshot ?? null,
      objectiveProfile: input.objectiveProfile ?? null,
      providerId: input.providerId ?? null,
      providerVersion: input.providerVersion ?? null,
      providerHash: input.providerHash ?? null,
      providerGeneration: input.providerGeneration ?? null,
      modelName: input.modelName?.trim().slice(0, 80) || null,
      modelDescription: input.modelDescription?.trim().slice(0, 500) || null,
    },
    metricsJson: null,
    gatesJson: null,
    artifactsPath: null,
    error: null,
    retryCount: 0,
    agentId: input.agent?.id ?? '',
    channelId: input.agent?.channelId ?? '',
    taskId: input.agent?.taskId ?? '',
    createdAt: now,
    startedAt: null,
    endedAt: null,
  }
  rt.repo.job.insert({
    id,
    datasetId: row.datasetId,
    purpose: row.purpose,
    budget: row.budget,
    agentId: row.agentId,
    channelId: row.channelId,
    taskId: row.taskId,
    createdAt: now,
  })
  state().queue.push(row)
  ensureTicker()
  recordOps({
    actor: row.agentId || 'aml', actorName: row.agentId || 'AML', actorKind: byKind,
    action: 'aml.job.submit', kind: 'write', summary: `提交训练作业 ${id}(dataset=${input.datasetId}, purpose=${row.purpose})`,
    targetKind: 'aml_job', targetId: id, lineId: dataset.lineId, productId: dataset.productId, recipeId: dataset.recipeId,
  })
  wsJob(row, dataset)
  return row
}
