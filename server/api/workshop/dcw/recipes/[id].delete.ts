/**
 * DELETE /api/workshop/dcw/recipes/:id —— 删除配方。
 *
 * 数据保留语义(2026-10-29 明确化):删除**只移除配方定义行** ——
 *   - 历史批次(runs)、数采样本(打标含 recipe_id)、AML 数据集与模型**一律保留**;
 *   - recipe_id 作为"墓碑键"继续存在于数据镜像中(数据集/模型行无外键,不级联);
 *   - 响应与产线日志附带 AML 谱系盘点(datasets/models 计数),删除可审计、数据可追溯;
 *   - AML 侧按 recipe_id 的历史查询/重训不受影响(显示层对已删配方回退为原始 id)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getDcwRecipeRepo } from '@/server/services/workshop/dcw/dcw-recipe.repo'
import { recordOps } from '@/server/services/workshop/ops/ops'
import { AppError, ErrorCodes } from '@/server/utils/errors'
import { requireLineForResource } from '@/server/services/workshop/line-scope'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  // 删除前取归属维度(remove 后不可读),产线日志按线/配方归档
  const recipe = getDcwRecipeRepo().byId(id)
  if (!recipe) throw new AppError(404, ErrorCodes.NOT_FOUND, `Recipe 不存在: ${id}`)
  requireLineForResource(user, recipe.lineId, '配方', 'operate')
  const activeRun = getDcwRecipeRepo().listRuns().find(r => r.recipeId === id && !r.endedAt)
  if (activeRun) {
    throw new AppError(409, ErrorCodes.CONFLICT, `配方「${recipe.name}」仍在批次 ${activeRun.id.slice(0, 8)} 中执行，请先停线/关批次后再删除`)
  }
  getDcwRecipeRepo().remove(id)
  // AML 谱系盘点(非阻断;动态 import 防模块环):删除不级联,计数只作保留证明与审计
  let amlLineage: { datasets: number, models: number, productionModels: number } | null = null
  try {
    const { getAmlRuntime } = await import('@/server/services/workshop/aml/runtime')
    const rt = getAmlRuntime()
    amlLineage = {
      datasets: rt.repo.dataset.list({ recipeId: id, limit: 500 }).length,
      models: rt.repo.model.list({ recipeId: id, limit: 500 }).length,
      productionModels: rt.repo.model.list({ recipeId: id, stage: 'production', limit: 50 }).length,
    }
  }
  catch { /* AML 运行时未就绪等;盘点失败不影响删除 */ }
  recordOps({
    actor: user.id, actorName: user.name, actorKind: 'user',
    action: 'recipe.delete', kind: 'recipe', targetKind: 'recipe', targetId: id,
    lineId: recipe?.lineId ?? '',
    productId: recipe?.productId ?? '',
    recipeId: id,
    summary: `删除配方「${recipe?.name ?? id}」${recipe?.lineId ? `(产线 ${recipe.lineId})` : ''}${amlLineage ? `(AML 数据保留:数据集 ${amlLineage.datasets} / 模型 ${amlLineage.models})` : ''}`,
    detail: { name: recipe?.name, productId: recipe?.productId, amlLineage },
  })
  return { deleted: true, dataRetention: { runs: '保留(历史批次台账)', samples: '保留(打标含本配方 id)', amlLineage } }
})
