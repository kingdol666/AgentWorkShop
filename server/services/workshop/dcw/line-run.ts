/**
 * LineRun 注册表 —— 逐产线活动批次(全局单例,Map<lineId, run>)。
 *
 * 多产线并存:每条产线独立开跑/停止,各自持有活动批次窗口。数采网关在入库时
 * 按节点所属产线取窗口为样本打 lineId/productId/recipeId/runId 标(产线级隔离);
 * 该产线停止即清其窗口。独立叶模块(无其他服务依赖),daq/dcw 两侧共用。
 *
 * 崩溃恢复(state 驱动初始化):结构性变更(开跑/停线)即落盘 line-runs.json,
 * 进程启动后首次访问时恢复窗口 —— 服务崩溃/重启后数采门控、写联锁、打标、
 * 保写心跳自动续跑,无需人工逐线重开。taggedSamples 为展示计数,不逐样本
 * 落盘(写放大),恢复时从最近一次结构变更的值继续。
 */

import path from 'node:path'
import { loadJsonFile, saveJsonFileAtomic } from '../json-store.mjs'

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

const PERSIST_PATH = process.cwd().endsWith('server')
  ? path.join('data', 'line-runs.json')
  : path.join(process.cwd(), 'server', 'data', 'line-runs.json')

const g = globalThis as typeof globalThis & {
  __activeLineRuns?: Map<string, ActiveLineRun>
  __lineRunsLoaded?: boolean
}

/** 从磁盘恢复活动窗口(幂等;首次访问触发;文件缺失/损坏 → 空窗口) */
function restore(): void {
  if (g.__lineRunsLoaded) return
  g.__lineRunsLoaded = true
  try {
    const arr: unknown = loadJsonFile(PERSIST_PATH, null)
    if (!Array.isArray(arr)) return
    for (const run of arr as ActiveLineRun[]) {
      if (run?.lineId && run.runId && run.recipeId) registry().set(run.lineId, run)
    }
  }
  catch {
    // 首次启动无文件,或历史文件损坏 → 从空窗口开始(与崩溃前不可得时语义一致)
  }
}

/** 结构性变更落盘(开跑/停线;非热路径) */
function persist(): void {
  try {
    saveJsonFileAtomic(PERSIST_PATH, getAllActiveLineRuns())
  }
  catch {
    // 落盘失败不阻断主流程:内存窗口仍是权威;下次结构性变更再试
  }
}

function registry(): Map<string, ActiveLineRun> {
  restore()
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
  persist()
}

export function clearActiveLineRun(lineId: string): ActiveLineRun | null {
  const map = registry()
  const prev = map.get(lineId) ?? null
  map.delete(lineId)
  persist()
  return prev
}

export function bumpTaggedSamples(lineId: string, n = 1): void {
  const run = registry().get(lineId)
  if (run) run.taggedSamples += n
}
