/**
 * Recipe 仓库 —— 配方 + 生产批次 + 写历史(server/data/dcw-*.json)。
 *
 * 产品隔离语义:每个 Recipe 应用生成一个 RecipeRun(批次),数采数据/写历史
 * 按批次时间窗归属产品;写历史追加式落盘(上限 3000 条,超出丢最旧)。
 */

import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RecipeDaqWindow, RecipeInput, RecipeParam, RecipeRunView, RecipeView } from '../../../../shared/dcw-protocol'
import { dcwKeyFromRef } from '../../../../shared/dcw-protocol'
import { AppError, ErrorCodes } from '../../../utils/errors'
import { getDcwProductRepo } from './dcw-product.repo'
import { getDcwNodeRepo } from './dcw-node.repo'
import { getDaqNodeRepo } from '../daq/daq-node.repo'
import { loadJsonFile, saveJsonFileAtomic } from '../json-store.mjs'

const DATA_DIR = process.cwd().endsWith('server')
  ? 'data'
  : path.join(process.cwd(), 'server', 'data')
const RECIPES_PATH = path.join(DATA_DIR, 'dcw-recipes.json')
const RUNS_PATH = path.join(DATA_DIR, 'dcw-runs.json')
const WRITES_PATH = path.join(DATA_DIR, 'dcw-writes.json')

const RUNS_CAP = 200
const WRITES_CAP = 3000

function loadJson<T>(file: string, fallback: T): T {
  return loadJsonFile(file, fallback) as T
}

function saveJson(file: string, data: unknown): void {
  saveJsonFileAtomic(file, data)
}

export interface DcwWriteHistoryEntry {
  id: string
  nodeId: string
  nodeName: string
  /** 参数语义(模板 ch) */
  param: string
  /** 工程值 / 原始值 */
  eng: number
  raw: number | null
  ok: boolean
  message: string
  recipeRunId: string | null
  at: string
}

/**
 * 配方参数归一化(**节点级绑定**):nodeId 必填且必须指向真实控制节点
 * (节点才是真实下发 PLC 的执行体;模板仅分类)。templateRef 为展示冗余,
 * 缺失时按节点自动补全。配方级窗口须 min <= value <= max。
 */
const normParams = (params: RecipeParam[] | undefined, lineId = ''): RecipeParam[] =>
  (params ?? [])
    .filter(p => p && Number.isFinite(Number(p.value)))
    .map((p) => {
      // 节点解析:nodeId 优先;兼容 templateRef 引用(自动解析到该模板最早创建的节点)
      let nodeId = String(p.nodeId ?? '').trim()
      if (!nodeId) {
        const key = dcwKeyFromRef(String(p.templateRef ?? ''))
        const cand = getDcwNodeRepo().all()
          .filter(n => n.templateKey === key)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
        nodeId = cand?.id ?? ''
      }
      if (!nodeId) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `配方参数无法解析到控制节点(nodeId/templateRef 均未命中): ${p.templateRef ?? p.nodeId}`)
      const node = getDcwNodeRepo().byId(nodeId)
      if (!node) throw new AppError(404, ErrorCodes.NOT_FOUND, `配方参数绑定的控制节点不存在: ${nodeId}`)
      // 产线隔离硬约束:参数节点必须属于配方产线;未分配节点自动收编,跨线节点拒绝
      if (lineId) {
        if (!node.lineId) node.lineId = lineId
        else if (node.lineId !== lineId) {
          throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `参数节点「${node.name}」属于其他产线,不可挂入本产线配方(产线隔离)`)
        }
      }
      const label = node.name
      const out: RecipeParam = { nodeId, templateRef: node.templateRef, value: Number(p.value) }
      const min = p.min == null ? undefined : Number(p.min)
      const max = p.max == null ? undefined : Number(p.max)
      if (min != null) {
        if (!Number.isFinite(min)) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `参数 ${label} 的配方下限需为数字`)
        out.min = min
      }
      if (max != null) {
        if (!Number.isFinite(max)) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `参数 ${label} 的配方上限需为数字`)
        out.max = max
      }
      if (out.min != null && out.max != null && out.min > out.max) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `参数 ${label} 的配方窗口非法:min ${out.min} > max ${out.max}`)
      }
      if (out.min != null && out.value < out.min) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `参数 ${label} 设定值 ${out.value} 低于配方下限 ${out.min}`)
      }
      if (out.max != null && out.value > out.max) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `参数 ${label} 设定值 ${out.value} 超出配方上限 ${out.max}`)
      }
      return out
    })

/**
 * 配方级数采监控窗口归一化:绑定数采节点(必填),产线隔离守卫
 * (未分配自动收编/跨线拒绝),窗口需至少一侧且 min <= max。
 */
const normDaqWindows = (windows: RecipeDaqWindow[] | undefined, lineId = ''): RecipeDaqWindow[] =>
  (windows ?? []).map((w) => {
    const nodeId = String(w.nodeId ?? '').trim()
    if (!nodeId) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, '数采监控窗口必须绑定数采节点(nodeId 必填)')
    const node = getDaqNodeRepo().byId(nodeId)
    if (!node) throw new AppError(404, ErrorCodes.NOT_FOUND, `监控窗口绑定的数采节点不存在: ${nodeId}`)
    if (lineId) {
      if (!node.lineId) {
        node.lineId = lineId
        getDaqNodeRepo().flushNow()
      }
      else if (node.lineId !== lineId) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `数采节点「${node.name}」属于其他产线,不可挂入本产线配方(产线隔离)`)
      }
    }
    const min = w.min == null ? undefined : Number(w.min)
    const max = w.max == null ? undefined : Number(w.max)
    if (min == null && max == null) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `数采节点「${node.name}」的监控窗口需至少提供 min 或 max`)
    if (min != null && !Number.isFinite(min)) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `数采节点「${node.name}」监控下限需为数字`)
    if (max != null && !Number.isFinite(max)) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `数采节点「${node.name}」监控上限需为数字`)
    if (min != null && max != null && min > max) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `数采节点「${node.name}」监控窗口非法:min ${min} > max ${max}`)
    const out: RecipeDaqWindow = { nodeId }
    if (min != null) out.min = min
    if (max != null) out.max = max
    return out
  })

class DcwRecipeRepo {
  private recipes: RecipeView[] = loadJson<RecipeView[]>(RECIPES_PATH, [])
  private runs: RecipeRunView[] = loadJson<RecipeRunView[]>(RUNS_PATH, [])
  private history: DcwWriteHistoryEntry[] = loadJson<DcwWriteHistoryEntry[]>(WRITES_PATH, [])
  private historyFlushTimer: NodeJS.Timeout | null = null

  // ---------- 配方 ----------

  list(): RecipeView[] {
    return this.recipes
  }

  byId(id: string): RecipeView | undefined {
    return this.recipes.find(r => r.id === id)
  }

  create(input: RecipeInput): RecipeView {
    const name = String(input.name ?? '').trim()
    if (!name) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Recipe 名称必填')
    // 配方必挂产品(数据隔离顶层维度:产品 → 配方 → 批次 → 样本)
    const productId = String(input.productId ?? '').trim()
    if (!productId) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'productId 必填:配方必须归属产品')
    const product = getDcwProductRepo().byId(productId)
    if (!product) throw new AppError(404, ErrorCodes.NOT_FOUND, `产品不存在: ${productId}`)
    const now = new Date().toISOString()
    const recipe: RecipeView = {
      id: `rc-${randomUUID().slice(0, 8)}`,
      productId,
      lineId: product.lineId,
      name,
      description: String(input.description ?? '').trim(),
      params: normParams(input.params, product.lineId),
      daqWindows: normDaqWindows(input.daqWindows, product.lineId),
      version: 1,
      paramsHistory: [],
      lastGoodRunId: null,
      createdAt: now,
      updatedAt: now,
    }
    this.recipes.push(recipe)
    this.flushRecipes()
    return recipe
  }

  update(id: string, patch: Partial<RecipeInput>): RecipeView {
    const r = this.byId(id)
    if (!r) throw new AppError(404, ErrorCodes.NOT_FOUND, `Recipe 不存在: ${id}`)
    if (patch.productId !== undefined && patch.productId !== r.productId) {
      const product = getDcwProductRepo().byId(String(patch.productId))
      if (!product) throw new AppError(404, ErrorCodes.NOT_FOUND, `产品不存在: ${patch.productId}`)
      r.productId = String(patch.productId)
    }
    if (patch.name !== undefined) {
      const name = String(patch.name).trim()
      if (!name) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Recipe 名称必填')
      r.name = name
    }
    if (patch.description !== undefined) r.description = String(patch.description).trim()
    if (patch.params !== undefined) {
      const fresh = normParams(patch.params, r.lineId)
      // 参数版本化(调控闭环):活动批次外的参数修改 → 版本自增 + 旧版入史(cap 20)
      const changed = JSON.stringify(fresh) !== JSON.stringify(r.params)
      if (changed) {
        r.paramsHistory ??= []
        r.paramsHistory.push({ version: r.version ?? 1, params: r.params, at: new Date().toISOString() })
        if (r.paramsHistory.length > 20)
          r.paramsHistory.splice(0, r.paramsHistory.length - 20)
        r.version = (r.version ?? 1) + 1
      }
      r.params = fresh
    }
    if (patch.daqWindows !== undefined) r.daqWindows = normDaqWindows(patch.daqWindows, r.lineId)
    r.updatedAt = new Date().toISOString()
    this.flushRecipes()
    return r
  }

  /** 标记已知良好批次(基准恢复的目标;Trial keep / 手动均可调) */
  markGood(recipeId: string, runId: string): RecipeView {
    const r = this.byId(recipeId)
    if (!r) throw new AppError(404, ErrorCodes.NOT_FOUND, `Recipe 不存在: ${recipeId}`)
    if (!this.runById(runId)) throw new AppError(404, ErrorCodes.NOT_FOUND, `批次不存在: ${runId}`)
    r.lastGoodRunId = runId
    this.flushRecipes()
    return r
  }

  remove(id: string): boolean {
    const before = this.recipes.length
    this.recipes = this.recipes.filter(r => r.id !== id)
    if (this.recipes.length !== before) {
      this.flushRecipes()
      return true
    }
    return false
  }

  // ---------- 生产批次 ----------

  listRuns(): RecipeRunView[] {
    return this.runs
  }

  runById(id: string): RecipeRunView | undefined {
    return this.runs.find(r => r.id === id)
  }

  /** 产品换线级联:直接设置配方产线归属 */
  setRecipeLine(id: string, lineId: string): void {
    const r = this.byId(id)
    if (r && r.lineId !== lineId) {
      r.lineId = lineId
      this.flushRecipes()
    }
  }

  /** 产线删除时解挂:配方 lineId 归空(数据保留) */
  detachLine(id: string): void {
    const r = this.byId(id)
    if (r && r.lineId !== '') {
      r.lineId = ''
      this.flushRecipes()
    }
  }

  createRun(recipe: RecipeView): RecipeRunView {
    const run: RecipeRunView = {
      id: `rr-${randomUUID().slice(0, 8)}`,
      recipeId: recipe.id,
      recipeName: recipe.name,
      productId: recipe.productId,
      lineId: recipe.lineId,
      startedAt: new Date().toISOString(),
      endedAt: null,
      results: [],
      // 参数冻结(调控闭环):配方事后修改不影响本批次的审计与回放
      paramsSnapshot: recipe.params.map(p => ({ ...p })),
    }
    this.runs.push(run)
    if (this.runs.length > RUNS_CAP) this.runs.splice(0, this.runs.length - RUNS_CAP)
    this.flushRuns()
    return run
  }

  closeRun(id: string): RecipeRunView {
    const run = this.runById(id)
    if (!run) throw new AppError(404, ErrorCodes.NOT_FOUND, `批次不存在: ${id}`)
    if (run.endedAt == null) run.endedAt = new Date().toISOString()
    this.flushRuns()
    return run
  }

  updateRun(run: RecipeRunView): void {
    this.flushRuns()
    void run
  }

  // ---------- 写历史 ----------

  appendHistory(entry: DcwWriteHistoryEntry): void {
    this.history.push(entry)
    if (this.history.length > WRITES_CAP) this.history.splice(0, this.history.length - WRITES_CAP)
    // 短窗防抖:保写心跳每 holdIntervalMs 追加一条,同步全量重写 writes.json
    // (≤3000 条)随节点数放大成周期性 fs 抖动;崩溃丢窗口内心跳帧无审计价值损失
    this.historyFlushTimer ??= setTimeout(() => {
      this.historyFlushTimer = null
      this.flushHistory()
    }, 1500)
    this.historyFlushTimer.unref?.()
  }

  historyList(limit = 100): DcwWriteHistoryEntry[] {
    return this.history.slice(-limit).reverse()
  }

  /** 批次窗口内的写历史(产品隔离查询;runId 直属优先,窗口兜底覆盖保写帧) */
  historyInWindow(startedAt: string, endedAt: string | null, runId: string): DcwWriteHistoryEntry[] {
    const end = endedAt ?? new Date().toISOString()
    return this.history.filter(h => h.at >= startedAt && h.at <= end && (h.recipeRunId === runId || h.recipeRunId === null))
  }

  private flushRecipes(): void {
    saveJson(RECIPES_PATH, this.recipes)
  }

  private flushRuns(): void {
    saveJson(RUNS_PATH, this.runs)
  }

  private flushHistory(): void {
    saveJson(WRITES_PATH, this.history)
  }
}

const g = globalThis as typeof globalThis & { __dcwRecipeRepo?: DcwRecipeRepo }

export function getDcwRecipeRepo(): DcwRecipeRepo {
  g.__dcwRecipeRepo ??= new DcwRecipeRepo()
  return g.__dcwRecipeRepo
}
