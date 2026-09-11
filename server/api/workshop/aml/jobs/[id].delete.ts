/**
 * DELETE /api/workshop/aml/jobs/:id —— 删除作业(元数据行 + 实验谱系 + 实体目录)。
 * 保护:运行中的作业拒绝删除(须先 cancel);已产出模型的作业拒绝删除(模型工件溯源依赖它)。
 * 权限:admin/editor。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { removeEntityDir } from '@/server/services/workshop/aml/entity'
import { recordOps } from '@/server/services/workshop/ops/ops'

const ACTIVE = new Set(['queued', 'provisioning', 'training', 'evaluating'])

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin', 'editor'])
  const id = getRouterParam(event, 'id') ?? ''
  const rt = getAmlRuntime()
  const job = rt.repo.job.get(id)
  if (!job) throw new AppError(404, 'AML_JOB_MISSING', `作业 ${id} 不存在`)
  if (ACTIVE.has(job.status)) {
    throw new AppError(409, 'AML_JOB_ACTIVE', `作业 ${id} 仍在 ${job.status} 状态,请先取消(cancel)再删除。`)
  }
  const ds = rt.repo.dataset.get(job.datasetId)
  if (ds) {
    const expIds = rt.repo.experiment.listByDataset(job.datasetId, 1000).filter(e => e.jobId === id).map(e => e.id)
    const models = rt.repo.model.list({ limit: 1000 }).filter(m => expIds.includes(m.experimentId))
    if (models.length > 0) {
      throw new AppError(409, 'AML_JOB_HAS_MODEL',
        `作业 ${id} 已产出模型 ${models.length} 个(${models.map(m => m.id).join(', ')}),拒绝删除:模型的可复现性溯源依赖该作业记录。请先删除对应模型。`)
    }
  }
  const ent = removeEntityDir(rt, 'job', id)
  const exps = rt.repo.job.removeExperimentsOf(id)
  rt.repo.job.remove(id)
  recordOps({
    actor: user.id, actorName: user.name, actorKind: 'user',
    action: 'aml.job.delete', kind: 'system',
    summary: `删除作业 ${id}(状态 ${job.status},级联实验 ${exps} 条)${ent.removed ? ',含实体目录' : ''}`,
    targetKind: 'aml_job', targetId: id,
  })
  return { deleted: true, entityRemoved: ent.removed, experimentsRemoved: exps, dir: ent.dir }
})
