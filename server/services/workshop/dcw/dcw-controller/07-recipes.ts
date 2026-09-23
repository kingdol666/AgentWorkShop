/**
 * DcwControllerLayer07 —— 配方 CRUD / 版本回退 / 应用
 * (分层 8/10,承 DcwControllerLayer06;方法体与原文件逐行一致)
 */
import { DcwControllerLayer06 } from './06-params'
import type { DcwWriteHistoryEntry } from '../dcw-recipe.repo'
import type { RecipeInput, RecipeRunView, RecipeView } from '../../../../../shared/dcw-protocol'
import { AppError, ErrorCodes } from '../../../../utils/errors'
import { getDcwRecipeRepo } from '../dcw-recipe.repo'
import { recordOps } from '../../ops/ops'

export abstract class DcwControllerLayer07 extends DcwControllerLayer06 {
  listRecipes() {
    return getDcwRecipeRepo().list()
  }

  createRecipe(input: RecipeInput) {
    return getDcwRecipeRepo().create(input)
  }

  updateRecipe(id: string, patch: Partial<RecipeInput>, meta?: { by: 'user' | 'agent' | 'system', actorName: string, actor: string, description: string }) {
    const recipe = getDcwRecipeRepo().update(id, patch, meta)
    // 配方参数版本变更 → 运维日志(版本号 + 归因;与版本历史同点入册)
    if (patch.params !== undefined) {
      try {
        recordOps({
          actor: meta?.actor ?? 'user',
          actorName: meta?.actorName ?? meta?.actor ?? 'user',
          actorKind: meta?.by ?? 'user',
          action: meta?.by === 'agent' ? 'recipe.update.agent' : 'recipe.update',
          kind: 'recipe',
          targetKind: 'recipe',
          targetId: id,
          summary: `更新配方「${recipe.name}」→ v${recipe.version ?? 1}${meta?.description ? `:${meta.description.slice(0, 80)}` : ''}`,
          lineId: recipe.lineId ?? '',
          productId: recipe.productId ?? '',
          recipeId: id,
          detail: { version: recipe.version ?? 1, description: meta?.description ?? '' },
        })
      }
      catch { /* 日志失败不影响更新 */ }
    }
    return recipe
  }

  /** 回退配方参数到历史版本/lastGood(生成新版本;非破坏) */
  revertRecipe(id: string, target: { version?: number, toLastGood?: boolean }, meta: { by: 'user' | 'agent' | 'system', actorName: string, actor: string, description: string }) {
    const recipe = getDcwRecipeRepo().revertToVersion(id, target, meta)
    try {
      recordOps({
        actor: meta.actor,
        actorName: meta.actorName,
        actorKind: meta.by,
        action: 'recipe.revert',
        kind: 'recipe',
        targetKind: 'recipe',
        targetId: id,
        summary: `回退配方「${recipe.name}」→ v${recipe.version ?? 1}${meta.description ? `:${meta.description.slice(0, 80)}` : ''}`,
        lineId: recipe.lineId ?? '',
        productId: recipe.productId ?? '',
        recipeId: id,
        detail: { version: recipe.version ?? 1, description: meta.description },
      })
    }
    catch { /* 日志失败不影响回退 */ }
    return recipe
  }

  recipeVersions(id: string) {
    return getDcwRecipeRepo().versions(id)
  }

  removeRecipe(id: string): void {
    if (!getDcwRecipeRepo().remove(id)) throw new AppError(404, ErrorCodes.NOT_FOUND, `Recipe 不存在: ${id}`)
  }

  listRuns() {
    return getDcwRecipeRepo().listRuns()
  }

  listHistory(limit = 100): DcwWriteHistoryEntry[] {
    return getDcwRecipeRepo().historyList(limit)
  }

  /**
   * 逐参数写核心(apply 与产线开跑共用):**节点级寻址** —— 每个参数显式指向
   * 控制节点(节点才是真实控制 PLC 工艺参数的执行体)→ 逐参数写命令
   * (runId 入写历史)→ 结果快照。节点不存在 → 该参数记失败不阻塞其余。
   */
  protected async writeRecipeParams(recipe: RecipeView, run: RecipeRunView): Promise<void> {
    const results: RecipeRunView['results'] = []
    for (const param of recipe.params) {
      const node = param.nodeId ? this.repo.byId(param.nodeId) : undefined
      if (!node) {
        results.push({ templateRef: param.templateRef ?? param.nodeId, nodeId: null, ok: false, message: `已跳过:节点 ${param.nodeId} 已删除,参数未下发`, value: param.value })
        continue
      }
      // 停用/解绑守卫:节点已停用或已不在配方所属产线(被解绑/改挂)→ 不下发,
      // 明确记因(run.results 可见),其余参数照常
      if (!node.enabled) {
        results.push({ templateRef: node.templateRef, nodeId: node.id, ok: false, message: `已跳过:节点「${node.name}」已停用,参数未下发`, value: param.value })
        continue
      }
      if (node.lineId !== recipe.lineId) {
        results.push({ templateRef: node.templateRef, nodeId: node.id, ok: false, message: `已跳过:节点「${node.name}」已取消绑定(${node.lineId ? '已改挂其他产线' : '已从产线移除'}),参数未下发`, value: param.value })
        continue
      }
      try {
        const outcome = await this.write(node.id, param.value, run.id, { source: 'recipe', actor: 'recipe' })
        results.push({ templateRef: node.templateRef, nodeId: node.id, ok: outcome.ok, message: outcome.message, value: param.value })
      }
      catch (err) {
        results.push({ templateRef: node.templateRef, nodeId: node.id, ok: false, message: err instanceof Error ? err.message : String(err), value: param.value })
      }
    }
    run.results = results
    getDcwRecipeRepo().updateRun(run)
  }

  /** Recipe 手动应用(一键下发工艺参数集;不激活产线窗口) */
  async applyRecipe(recipeId: string) {
    this.ensureLoop()
    const repo = getDcwRecipeRepo()
    const recipe = repo.byId(recipeId)
    if (!recipe) throw new AppError(404, ErrorCodes.NOT_FOUND, `Recipe 不存在: ${recipeId}`)
    if (recipe.params.length === 0) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Recipe 无工艺参数,无可下发内容')
    const run = repo.createRun(recipe)
    await this.writeRecipeParams(recipe, run)
    return run
  }

  closeRun(id: string) {
    return getDcwRecipeRepo().closeRun(id)
  }

  // ---------- 产线(实体 CRUD;节点/产品/配方挂载其下实现隔离) ----------
}
