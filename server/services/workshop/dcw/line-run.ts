/**
 * LineRun 注册表 —— 产线当前活动批次(全局单例)。
 *
 * 产线开跑(选定产品+配方)后,数采网关在入库时为每条样本打上
 * productId/recipeId/runId 标(批次窗口内逐样本隔离);停止数采即清空。
 * 独立叶模块(无其他服务依赖),daq/dcw 两侧共用。
 */

export interface ActiveLineRun {
  runId: string
  recipeId: string
  recipeName: string
  productId: string
  productName: string
  startedAt: string
  /** 本窗口已打标入库的样本数(查询时随 LineRunState 暴露) */
  taggedSamples: number
}

const g = globalThis as typeof globalThis & { __activeLineRun?: ActiveLineRun | null }

export function getActiveLineRun(): ActiveLineRun | null {
  return g.__activeLineRun ?? null
}

export function setActiveLineRun(run: ActiveLineRun): void {
  g.__activeLineRun = run
}

export function clearActiveLineRun(): ActiveLineRun | null {
  const prev = g.__activeLineRun ?? null
  g.__activeLineRun = null
  return prev
}

export function bumpTaggedSamples(n: number): void {
  const run = g.__activeLineRun
  if (run) run.taggedSamples += n
}
