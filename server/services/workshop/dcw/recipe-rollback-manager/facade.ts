/**
 * RecipeRollBackManager —— 组合各分层后的最终类(可见性/继承/实现接口与拆分前一致)
 * + 原文件类体之后引用本类的模块级代码(单例/工厂/广播装配)。
 */
import { RecipeRollBackManagerLayer06 } from './06-internal'

export class RecipeRollBackManager extends RecipeRollBackManagerLayer06 {}
const g = globalThis as typeof globalThis & { __recipeRollBackManager?: RecipeRollBackManager }

export function getRecipeRollBackManager(): RecipeRollBackManager {
  g.__recipeRollBackManager ??= new RecipeRollBackManager()
  return g.__recipeRollBackManager
}
