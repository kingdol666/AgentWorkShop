/**
 * RecipeRollBackManagerLayer00 —— 状态字段与广播装配
 * (分层 1/7,承 RecipeRollBackManagerContracts;方法体与原文件逐行一致)
 */
import { RecipeRollBackManagerContracts } from './contracts'
import type { RecipeRollBackRepo } from '../recipe-rollback.repo'
import { getRecipeRollBackRepo } from '../recipe-rollback.repo'

export abstract class RecipeRollBackManagerLayer00 extends RecipeRollBackManagerContracts {
  protected repo: RecipeRollBackRepo = getRecipeRollBackRepo()
  protected broadcast: ((type: string, payload: unknown) => void) | null = null
  protected capturing = new Set<string>()

  setBroadcast(fn: ((type: string, payload: unknown) => void) | null): void {
    this.broadcast = fn
  }

  // ================================================================
  // 写路径挂钩(DcwController.write 调用)
  // ================================================================
}
