/**
 * GET /api/workshop/aml/models/:id —— 单模型详情(主资源路径)。
 *
 * 对称性修复(2026-11-09):该路径此前只有 PATCH/DELETE 与 [id]/promote、[id]/predict,
 * 主资源路径可改不可读 —— 读侧只能拉 /aml/models 全量列表再前端筛。
 * 授权口径与列表一致:登录 + 按数据集 lineId 的产线可见性过滤(filterByLine/requireLineMode readonly)。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const rt = getAmlRuntime()
  const model = rt.repo.model.get(id)
  if (!model) throw new AppError(404, 'AML_MODEL_MISSING', `模型 ${id} 不存在`)
  // 可见性:与列表同源(该模型所属数据集的产线读授权);admin/无权产线的判定在 requireLineMode 内
  requireLineMode(user, rt.repo.dataset.get(model.datasetId)?.lineId, 'readonly')
  return { model }
})
