/**
 * 运行时工况/配方版本重校验(plan §3.1 / A13):
 *  - 当前配方版本与 spec 冻结版本不一致 → 计划失效;
 *  - 批次谱系段版本不一致(运行中切换)→ 失效;
 *  - 声明身份必须命中工况,且命中集合两两不重叠。
 *
 * stage 子句在首版视为**运行时未知维度**(产线批次没有结构化 stage 来源):
 * 发布与运行都用同一"忽略 stage 静态匹配 + 两两不重叠"口径,避免 stage 型工况永远不命中。
 */
import type { ProcessModelSpec } from './contracts'
import type { ContextSnapshot } from './context'
import { conditionsOverlap } from './spec'
import { getContextSegmentRepo } from './context-segments.repo'
import { getDcwRecipeRepo } from '../dcw/dcw-recipe.repo'

export async function isRuntimeConditionChanged(spec: ProcessModelSpec, context: ContextSnapshot): Promise<boolean> {
  const recipe = getDcwRecipeRepo().byId(spec.recipeId)
  if (recipe?.version != null && spec.recipeVersion !== 0 && recipe.version !== spec.recipeVersion) return true
  const segment = getContextSegmentRepo().at(spec.lineId, context.eventAsOf)
  if (segment && segment.confirmed === 1) {
    // 运行中切换到不同配方(recipeId 变化)或同配方升版 → 旧计划失效
    if (segment.recipeId !== spec.recipeId) return true
    if (segment.recipeVersion !== 0 && segment.recipeVersion !== spec.recipeVersion) return true
  }
  const actual: Record<string, unknown> = {
    lineId: spec.lineId, productId: spec.productId, recipeId: spec.recipeId, recipeVersion: spec.recipeVersion,
  }
  const matching = spec.conditions.filter(condition => condition.match.every((clause) => {
    if (clause.field === 'stage') return true
    const value = actual[clause.field]
    if (clause.op === 'eq') return String(value ?? '') === String(clause.value)
    if (typeof value !== 'number') return false
    const [lo, hi] = clause.value as [number, number]
    return value >= lo && value <= hi
  }))
  if (matching.length === 0) return true
  for (let i = 0; i < matching.length; i++) {
    for (let j = i + 1; j < matching.length; j++) {
      if (conditionsOverlap(matching[i]!, matching[j]!)) return true
    }
  }
  return false
}
