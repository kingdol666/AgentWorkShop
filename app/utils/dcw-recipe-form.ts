/**
 * 配方编辑表单的行形状与空行工厂 —— 页面(useDcwRecipes)与弹窗(DcwRecipeEditModal)
 * 共用的单一事实源(此前行字面量在 4 处重复,漂移会导致保存/校验错位)。
 * 空值约定:'' = 未填(提交时归一化为省略),数字 = 已填。
 */
export interface DcwRecipeParamRow {
  nodeId: string
  value: number | ''
  min: number | ''
  max: number | ''
  stepLimit: number | ''
}

export interface DcwRecipeDaqWindowRow {
  nodeId: string
  min: number | ''
  max: number | ''
}

export function emptyRecipeParamRow(nodeId = ''): DcwRecipeParamRow {
  return { nodeId, value: '', min: '', max: '', stepLimit: '' }
}

export function emptyRecipeDaqWindowRow(nodeId = ''): DcwRecipeDaqWindowRow {
  return { nodeId, min: '', max: '' }
}
