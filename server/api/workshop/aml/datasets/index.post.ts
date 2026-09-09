/**
 * POST /api/workshop/aml/datasets —— 构建数据集快照(同步;隔离三元组必填)。
 * body: AmlDatasetSpec(见 spec.ts);权限 = 产线 readonly + 节点产线一致(构建器内校验)。
 */
import { readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { recordOps } from '@/server/services/workshop/ops/ops'
import { parseDatasetSpec } from '@/server/services/workshop/aml/spec'
import { buildDataset } from '@/server/services/workshop/aml/dataset-builder'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const spec = parseDatasetSpec(body)
  requireLineMode(user, spec.lineId, 'readonly')
  const { dataset, report } = await buildDataset(spec, { id: user.id, kind: 'user' })
  recordOps({
    actor: user.id, actorName: user.name, actorKind: 'user',
    action: 'aml.dataset.build', kind: 'system',
    summary: `构建数据集 ${dataset.id}(${dataset.rowCount} 行 / ${dataset.runIds.length} 批次)`,
    targetKind: 'aml_dataset', targetId: dataset.id,
    lineId: dataset.lineId, productId: dataset.productId, recipeId: dataset.recipeId,
  })
  return { dataset, report: { ...report, nodeSummaries: report.nodeSummaries.slice(0, 64) } }
})
