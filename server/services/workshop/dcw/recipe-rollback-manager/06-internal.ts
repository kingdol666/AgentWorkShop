/**
 * RecipeRollBackManagerLayer06 —— 内部:事件广播
 * (分层 7/7,承 RecipeRollBackManagerLayer05;方法体与原文件逐行一致)
 */
import { RecipeRollBackManagerLayer05 } from './05-views'
import type { OptimizationRecord } from '../../../../../shared/dcw-protocol'
import { getActiveLineRun } from '../line-run'
import { getAgentNodeBindingRepo } from '../../agents/node-bindings.repo'
import { getDcwRecipeRepo } from '../dcw-recipe.repo'

export abstract class RecipeRollBackManagerLayer06 extends RecipeRollBackManagerLayer05 {
  protected resolvePolicy(nodeId: string, actor: string): 'auto_rollback' | 'approve_rollback' | 'observe_only' {
    if (actor && actor !== 'system') {
      const binding = getAgentNodeBindingRepo().byAgent(actor).find(b => b.kind === 'dcw' && b.nodeId === nodeId)
      if (binding)
        return binding.mode === 'manual' ? 'approve_rollback' : 'auto_rollback'
    }
    const anyBinding = getAgentNodeBindingRepo().byNode(nodeId).find(b => b.kind === 'dcw')
    return anyBinding ? (anyBinding.mode === 'manual' ? 'approve_rollback' : 'auto_rollback') : 'observe_only'
  }

  protected markGoodFromRecord(record: OptimizationRecord): void {
    if (!record.recipeId)
      return
    const run = getActiveLineRun(record.lineId)
    if (run && run.recipeId === record.recipeId)
      getDcwRecipeRepo().markGood(record.recipeId, run.runId)
  }

  protected emit(event: 'opened' | 'judged' | 'closed' | 'rolled-back', record: OptimizationRecord): void {
    this.broadcast?.('dcw.optimization.changed', { event, record })
  }
}
