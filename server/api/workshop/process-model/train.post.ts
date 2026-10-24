/**
 * POST /api/workshop/process-model/train —— 内置训练器作业(配置驱动,无需用户代码)。
 * body: { spec, datasetId, modelName?, modelDescription? }
 * 权限:editor/admin 角色 + 产线可见性(readonly)+ 训练提交入册(D16/SW1.6;viewer 不可提交算力作业)。
 */
import { readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { parseProcessModelSpec } from '@/server/services/workshop/process-model/spec'
import { submitJob } from '@/server/services/workshop/aml/job-orchestrator'
import { assertOptimizationAccess, recordConfigAction } from '@/server/services/workshop/optimization/access'
import { AppError } from '@/server/utils/errors'

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin', 'editor'])
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const spec = parseProcessModelSpec(body.spec)
  const datasetId = String(body.datasetId ?? '')
  if (!datasetId) throw new AppError(422, 'DATASET_REQUIRED', 'datasetId 必填(先构建 manifest v2 数据集)')
  assertOptimizationAccess(user, 'write', { kind: 'train', lineId: spec.lineId })
  assertOptimizationAccess(user, 'read', { kind: 'dataset', id: datasetId })
  const job = submitJob({
    datasetId,
    purpose: spec.purpose,
    trainerRef: spec.trainer.ref,
    processModelSpec: spec as unknown as Record<string, unknown>,
    modelName: typeof body.modelName === 'string' ? body.modelName : `${spec.id}@${spec.version}`,
    modelDescription: typeof body.modelDescription === 'string' ? body.modelDescription : `ProcessModelSpec ${spec.id}@${spec.version}(${spec.trainer.ref})`,
    agent: { id: user.id },
    byKind: 'user',
  })
  recordConfigAction(user, 'process_model.train.submit', { kind: 'aml_job', id: job.id },
    `提交训练作业 ${job.id}(spec=${spec.id}@${spec.version},trainer=${spec.trainer.ref})`,
    { datasetId, trainerRef: spec.trainer.ref }, spec.lineId)
  return { job }
})
