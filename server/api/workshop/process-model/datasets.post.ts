/**
 * POST /api/workshop/process-model/datasets —— 按 ProcessModelSpec 构建 manifest v2 数据集。
 * body: ProcessModelSpec(完整);权限 = 产线 readonly。
 */
import { readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { recordOps } from '@/server/services/workshop/ops/ops'
import { parseProcessModelSpec } from '@/server/services/workshop/process-model/spec'
import { buildProcessModelDataset } from '@/server/services/workshop/process-model/dataset'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const spec = parseProcessModelSpec(body)
  requireLineMode(user, spec.lineId, 'readonly')
  const built = await buildProcessModelDataset(body, { id: user.id, kind: 'user' })
  recordOps({
    actor: user.id, actorName: user.name, actorKind: 'user',
    action: 'process_model.dataset.build', kind: 'system',
    summary: `构建过程模型数据集 ${built.datasetId}(${built.rowCount} 窗 / ${built.runIds.length} 批次;recipe v${built.recipeVersion})`,
    targetKind: 'aml_dataset', targetId: built.datasetId, lineId: spec.lineId,
  })
  return built
})
