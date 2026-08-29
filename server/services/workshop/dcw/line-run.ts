/**
 * LineRun 注册表 —— 逐产线活动批次(全局单例,Map<lineId, run>)。
 *
 * 多产线并存:每条产线独立开跑/停止,各自持有活动批次窗口。数采网关在入库时
 * 按节点所属产线取窗口为样本打 lineId/productId/recipeId/runId 标(产线级隔离);
 * 该产线停止即清其窗口。独立叶模块(无其他服务依赖),daq/dcw 两侧共用。
 */

export interface ActiveLineRun {
  lineId: string
  runId: string
  recipeId: string
  recipeName: string
  productId: string
  productName: string
  startedAt: string
  /** 本窗口已打标入库的样本数(查询时随 LineRunState 暴露) */
  taggedSamples: number
}

const g = globalThis as typeof globalThis & { __activeLineRuns?: Map<string, ActiveLineRun> }

function registry(): Map<string, ActiveLineRun> {
  g.__activeLineRuns ??= new Map()
  return g.__activeLineRuns
}

/**
 * 取指定产线的活动窗口(**严格语义**:lineId 空/未分配 → null,不受任何产线运行影响;
 * 需要「任意活动窗口」时显式用 getAllActiveLineRuns())。
 */
export function getActiveLineRun(lineId?: string): ActiveLineRun | null {
  if (!lineId) return null
  return registry().get(lineId) ?? null
}

export function getAllActiveLineRuns(): ActiveLineRun[] {
  return [...registry().values()]
}

export function setActiveLineRun(run: ActiveLineRun): void {
  registry().set(run.lineId, run)
}

export function clearActiveLineRun(lineId: string): ActiveLineRun | null {
  const map = registry()
  const prev = map.get(lineId) ?? null
  map.delete(lineId)
  return prev
}

export function bumpTaggedSamples(lineId: string, n = 1): void {
  const run = registry().get(lineId)
  if (run) run.taggedSamples += n
}
