/**
 * POST /api/workshop/aml/jobs —— 提交训练作业(可内联 train.py 代码,平台写入作业工作区)。
 * body: { datasetId, purpose?, parentExperimentId?, changeNote?, params?, seed?, budget?, code?,
 *         sceneId?, sceneVersion?, objectiveId?, jobKind?, physicsSpec?, twinSnapshot?, objectiveProfile?,
 *         providerId?, providerVersion?, providerHash?, providerGeneration?, modelName?, modelDescription? }
 * Hybrid Twin 字段进入不可变 budget_json(谱系);jobKind=hybrid_residual 且无 code 时
 * 平台使用内置参考训练器(物理参数校准→残差集成→UQ 校准)。
 */
import { readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { submitJob } from '@/server/services/workshop/aml/job-orchestrator'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<{
    datasetId?: string
    purpose?: 'mpc_surrogate' | 'quality_predict'
    parentExperimentId?: string
    changeNote?: string
    params?: Record<string, unknown>
    seed?: number
    budget?: { maxExperiments?: number }
    code?: string
    sceneId?: string
    sceneVersion?: string
    objectiveId?: string
    jobKind?: 'supervised' | 'physics_calibration' | 'hybrid_residual' | 'uncertainty_calibration'
    physicsSpec?: Record<string, unknown>
    twinSnapshot?: Record<string, unknown>
    objectiveProfile?: Record<string, unknown>
    providerId?: string
    providerVersion?: string
    providerHash?: string
    providerGeneration?: number
    modelName?: string
    modelDescription?: string
  }>(event) ?? {}
  if (!body.datasetId) throw new AppError(422, 'AML_SPEC_INVALID', '缺少 datasetId')
  if (body.code && body.code.length > 512_000) throw new AppError(422, 'AML_CODE_TOO_LARGE', '训练代码超过 500KB 上限')
  const rt = getAmlRuntime()
  const ds = rt.repo.dataset.get(body.datasetId)
  if (!ds) throw new AppError(404, 'AML_DATASET_MISSING', `数据集 ${body.datasetId} 不存在`)
  requireLineMode(user, ds.lineId, 'readonly')
  const job = submitJob({
    datasetId: body.datasetId,
    purpose: body.purpose,
    parentExperimentId: body.parentExperimentId ?? null,
    changeNote: body.changeNote ?? '',
    params: body.params ?? {},
    seed: body.seed,
    budget: body.budget,
    code: body.code,
    sceneId: body.sceneId,
    sceneVersion: body.sceneVersion,
    objectiveId: body.objectiveId,
    jobKind: body.jobKind,
    physicsSpec: body.physicsSpec,
    twinSnapshot: body.twinSnapshot,
    objectiveProfile: body.objectiveProfile,
    providerId: body.providerId,
    providerVersion: body.providerVersion,
    providerHash: body.providerHash,
    providerGeneration: body.providerGeneration,
    modelName: body.modelName,
    modelDescription: body.modelDescription,
    agent: { id: user.id },
    byKind: 'user',
  })
  return { job }
})
