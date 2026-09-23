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
  /** 发起者;byKind 决定审计归属(actorKind) */
  agent?: { id: string, channelId?: string, taskId?: string }
  byKind?: 'user' | 'agent'
  /** 实验谱系:由重试等内部路径复用既有 experiment 行 */
  experimentId?: string
}

export function submitJob(input: SubmitJobInput): AmlJobRow {
  const rt = getAmlRuntime()
  const s = amlSettings()
  const dataset = rt.repo.dataset.get(input.datasetId)
  if (!dataset) throw new AppError(404, 'AML_DATASET_MISSING', `数据集 ${input.datasetId} 不存在`)

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
