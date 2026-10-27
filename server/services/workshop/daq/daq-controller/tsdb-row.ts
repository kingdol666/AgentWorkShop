/**
 * TSDB 行装配(纯函数,便于单测)。
 *
 * 语义(F7a):
 *  - lineId = 节点所属产线(配置事实),未开线也写入 —— 未开线时段样本可按线检索;
 *  - product/recipe/run 只在活动 LineRun 窗口内才有值(批次语义不被伪造);
 *  - 未分配产线的节点 lineId 保持 null(不冒充任何产线)。
 */
export interface TsdbRunTags {
  lineId: string
  productId?: string | null
  recipeId?: string | null
  runId?: string | null
}

export interface TsdbSampleInput {
  nodeId: string
  tsMs: number
  value: number
  state: string
  nodeLineId?: string | null
  run: TsdbRunTags | null
}

export interface TsdbSampleRow {
  nodeId: string
  tsMs: number
  value: number
  state: string
  lineId: string | null
  productId: string | null
  recipeId: string | null
  runId: string | null
}

export function tsdbRowOf(input: TsdbSampleInput): TsdbSampleRow {
  const nodeLine = input.nodeLineId ? String(input.nodeLineId) : ''
  return {
    nodeId: input.nodeId,
    tsMs: input.tsMs,
    value: input.value,
    state: input.state,
    lineId: nodeLine || null,
    productId: input.run?.productId ?? null,
    recipeId: input.run?.recipeId ?? null,
    runId: input.run?.runId ?? null,
  }
}
